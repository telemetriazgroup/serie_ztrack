/**
 * Consola serial de alto caudal.
 * - RX nunca bloquea el hilo de lectura (cola + drenado por rAF/timer).
 * - Vista fija (50 líneas) con scroll; el historial se recorta por maxLineas.
 * - Búsqueda de palabra/frase con saltos anterior/siguiente.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class ConsolaSerial {
  /**
   * @param {HTMLElement} el
   * @param {{ maxLineas?: number, maxCola?: number, onMetricas?: Function, onBusqueda?: Function }} opts
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.maxLineas = opts.maxLineas ?? 50;
    this.maxCola = opts.maxCola ?? 2000;
    this.onMetricas = opts.onMetricas || null;
    this.onBusqueda = opts.onBusqueda || null;

    this.lineas = [];
    this.cola = [];
    this.pausado = false;
    this.autoScroll = true;
    this.conTimestamp = false;

    this._query = "";
    this._matches = [];
    this._matchIdx = -1;

    this._raf = 0;
    this._timer = 0;
    this._bytesVentana = 0;
    this._lineasDescartadas = 0;
    this._ultimaMetrica = 0;
    this._rxTotal = 0;
  }

  setAutoScroll(v) {
    this.autoScroll = Boolean(v);
  }

  setTimestamp(v) {
    this.conTimestamp = Boolean(v);
  }

  setPausado(v) {
    this.pausado = Boolean(v);
    if (!this.pausado) this._programarFlush();
  }

  limpiar() {
    this.lineas = [];
    this.cola = [];
    this._matches = [];
    this._matchIdx = -1;
    this.el.textContent = "";
    this._emitMetricas(true);
    this._emitBusqueda();
  }

  /** Entrada de sistema / TX (prioridad: no se descarta fácil). */
  log(text, cls = "sys") {
    this._encolar({ text: String(text), cls, prio: cls === "rx" ? 0 : 1 });
  }

  /** Entrada RX (puede descartarse si hay sobrecarga). */
  rxLinea(text) {
    const prefix = this.conTimestamp ? `${this._hora()} ` : "";
    this._encolar({ text: `${prefix}${text}`, cls: "rx", prio: 0 });
  }

  contarBytes(n) {
    this._bytesVentana += n;
    this._rxTotal += n;
  }

  setBusqueda(query) {
    this._query = String(query || "").trim();
    this._matchIdx = -1;
    this._recalcularMatches();
    if (this._matches.length) {
      this._matchIdx = 0;
      this.autoScroll = false;
    }
    this._pintar({ saltar: true });
    this._emitBusqueda();
  }

  siguienteMatch() {
    if (!this._matches.length) return;
    this._matchIdx = (this._matchIdx + 1) % this._matches.length;
    this.autoScroll = false;
    this._pintar({ saltar: true });
    this._emitBusqueda();
  }

  anteriorMatch() {
    if (!this._matches.length) return;
    this._matchIdx = (this._matchIdx - 1 + this._matches.length) % this._matches.length;
    this.autoScroll = false;
    this._pintar({ saltar: true });
    this._emitBusqueda();
  }

  _hora() {
    const d = new Date();
    return d.toLocaleTimeString("es-PE", { hour12: false }) +
      "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  _encolar(item) {
    if (this.pausado && item.cls === "rx") {
      this._lineasDescartadas += 1;
      this._emitMetricas();
      return;
    }

    this.cola.push(item);
    if (this.cola.length > this.maxCola) {
      const overflow = this.cola.length - this.maxCola;
      let quitados = 0;
      const keep = [];
      for (const it of this.cola) {
        if (quitados < overflow && it.prio === 0) {
          quitados += 1;
          continue;
        }
        keep.push(it);
      }
      this.cola = keep.length > this.maxCola ? keep.slice(-this.maxCola) : keep;
      this._lineasDescartadas += Math.max(overflow, quitados);
    }
    this._programarFlush();
  }

  _programarFlush() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._flush();
    });
    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._timer = 0;
        if (this.cola.length) this._flush();
      }, 120);
    }
  }

  _flush() {
    if (!this.cola.length) {
      this._emitMetricas();
      return;
    }

    const lote = this.cola;
    this.cola = [];

    for (const item of lote) {
      let line = item.text;
      if (item.cls === "tx") line = `› ${item.text.replace(/^›\s*/, "")}`;
      else if (item.cls === "sys") line = `· ${item.text}`;
      else if (item.cls === "ok") line = `✓ ${item.text}`;
      else if (item.cls === "warn") line = `! ${item.text}`;
      else if (item.cls === "err") line = `× ${item.text}`;
      this.lineas.push(line);
    }

    if (this.lineas.length > this.maxLineas) {
      this.lineas = this.lineas.slice(-this.maxLineas);
    }

    this._recalcularMatches();
    this._pintar({ saltar: false });
    this._emitMetricas();
    if (this._query) this._emitBusqueda();
  }

  _recalcularMatches() {
    this._matches = [];
    const q = this._query.toLowerCase();
    if (!q) {
      this._matchIdx = -1;
      return;
    }
    for (let i = 0; i < this.lineas.length; i++) {
      const lower = this.lineas[i].toLowerCase();
      let from = 0;
      while (from <= lower.length - q.length) {
        const at = lower.indexOf(q, from);
        if (at < 0) break;
        this._matches.push({ line: i, at, len: q.length });
        from = at + q.length;
      }
    }
    if (!this._matches.length) this._matchIdx = -1;
    else if (this._matchIdx >= this._matches.length) this._matchIdx = this._matches.length - 1;
  }

  _pintar({ saltar }) {
    const nearBottom =
      this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 80;
    const q = this._query;

    if (!q) {
      this.el.textContent = this.lineas.join("\n");
      if (this.autoScroll && nearBottom) {
        this.el.scrollTop = this.el.scrollHeight;
      }
      return;
    }

    const current = this._matchIdx;
    let matchCursor = 0;
    const html = this.lineas
      .map((line, i) => {
        const marked = this._marcarLinea(line, q, i, () => {
          const idx = matchCursor;
          matchCursor += 1;
          return idx === current;
        });
        const cls = marked.hasHit ? "ln has-hit" : "ln";
        return `<div class="${cls}" data-i="${i}">${marked.html}</div>`;
      })
      .join("");
    this.el.innerHTML = html;

    if (saltar) this._scrollToCurrentMatch();
    else if (this.autoScroll && nearBottom && this._matchIdx < 0) {
      this.el.scrollTop = this.el.scrollHeight;
    }
  }

  _marcarLinea(text, query, _lineIdx, isCurrentFn) {
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    if (!q || !lower.includes(q)) {
      return { html: escapeHtml(text), hasHit: false };
    }
    let out = "";
    let pos = 0;
    let hasHit = false;
    while (pos < text.length) {
      const at = lower.indexOf(q, pos);
      if (at < 0) {
        out += escapeHtml(text.slice(pos));
        break;
      }
      hasHit = true;
      out += escapeHtml(text.slice(pos, at));
      const cur = isCurrentFn() ? " current" : "";
      out += `<mark class="hit${cur}">${escapeHtml(text.slice(at, at + query.length))}</mark>`;
      pos = at + query.length;
    }
    return { html: out, hasHit };
  }

  _scrollToCurrentMatch() {
    if (this._matchIdx < 0) return;
    const hit = this.el.querySelector("mark.hit.current");
    if (hit) {
      hit.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
    const m = this._matches[this._matchIdx];
    if (!m) return;
    const row = this.el.querySelector(`[data-i="${m.line}"]`);
    row?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  _emitBusqueda() {
    this.onBusqueda?.({
      query: this._query,
      total: this._matches.length,
      actual: this._matchIdx < 0 ? 0 : this._matchIdx + 1,
    });
  }

  _emitMetricas(force = false) {
    const now = performance.now();
    if (!force && now - this._ultimaMetrica < 400) return;
    const elapsed = Math.max(0.001, (now - this._ultimaMetrica) / 1000);
    const bps = this._ultimaMetrica ? Math.round(this._bytesVentana / elapsed) : 0;
    this._bytesVentana = 0;
    this._ultimaMetrica = now;
    this.onMetricas?.({
      bps,
      rxTotal: this._rxTotal,
      lineas: this.lineas.length,
      cola: this.cola.length,
      descartadas: this._lineasDescartadas,
      pausado: this.pausado,
    });
  }
}

/**
 * Decodifica bytes → líneas sin bloquear; entrega lotes.
 */
export class DecodificadorLineas {
  constructor() {
    this.pending = "";
    this.decoder = new TextDecoder();
  }

  push(bytes) {
    const chunk = this.decoder.decode(bytes, { stream: true });
    this.pending += chunk;
    if (this.pending.length > 8192) {
      const forzadas = [this.pending];
      this.pending = "";
      return [forzadas, chunk];
    }
    const partes = this.pending.split(/\r\n|\n|\r/);
    this.pending = partes.pop() ?? "";
    const lineas = partes.filter((l) => l.length > 0);
    return [lineas, chunk];
  }

  flush() {
    if (!this.pending) return [];
    const l = this.pending;
    this.pending = "";
    return [l];
  }
}
