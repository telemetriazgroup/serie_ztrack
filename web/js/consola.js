/**
 * Consola serial de alto caudal.
 * - Guarda todo lo recibido (sin recorte).
 * - Vista de altura fija con scroll; el DOM se actualiza por lotes.
 * - Búsqueda de palabra/frase y exportación TXT / CSV.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function csvCell(s) {
  const t = String(s ?? "").replace(/\r\n/g, "\n");
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function descargarBlob(contenido, mime, nombre) {
  const blob = new Blob([contenido], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function nombreArchivo(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `ztrack-serial-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

export class ConsolaSerial {
  /**
   * @param {HTMLElement} el
   * @param {{ maxCola?: number, onMetricas?: Function, onBusqueda?: Function }} opts
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.maxCola = opts.maxCola ?? 4000;
    this.onMetricas = opts.onMetricas || null;
    this.onBusqueda = opts.onBusqueda || null;

    /** @type {{ iso: string, hora: string, cls: string, text: string, display: string }[]} */
    this.registros = [];
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
    this._ultimaMetrica = 0;
    this._rxTotal = 0;
    this._pintadoHasta = 0;
    this._modoMarcas = false;
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
    this.registros = [];
    this.cola = [];
    this._matches = [];
    this._matchIdx = -1;
    this._pintadoHasta = 0;
    this._modoMarcas = false;
    this.el.textContent = "";
    this._emitMetricas(true);
    this._emitBusqueda();
  }

  log(text, cls = "sys") {
    this._encolar({ text: String(text), cls });
  }

  rxLinea(text) {
    this._encolar({ text: String(text), cls: "rx" });
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
    this._pintar({ saltar: true, forzar: true });
    this._emitBusqueda();
  }

  siguienteMatch() {
    if (!this._matches.length) return;
    this._matchIdx = (this._matchIdx + 1) % this._matches.length;
    this.autoScroll = false;
    this._pintar({ saltar: true, forzar: false });
    this._emitBusqueda();
  }

  anteriorMatch() {
    if (!this._matches.length) return;
    this._matchIdx = (this._matchIdx - 1 + this._matches.length) % this._matches.length;
    this.autoScroll = false;
    this._pintar({ saltar: true, forzar: false });
    this._emitBusqueda();
  }

  exportarTxt() {
    const cuerpo = this.registros
      .map((r) => `${r.iso}\t${r.cls}\t${r.text}`)
      .join("\n");
    descargarBlob(cuerpo ? `${cuerpo}\n` : "", "text/plain;charset=utf-8", nombreArchivo("txt"));
  }

  exportarCsv() {
    const header = "hora_iso,hora_local,tipo,contenido";
    const filas = this.registros.map(
      (r) => `${csvCell(r.iso)},${csvCell(r.hora)},${csvCell(r.cls)},${csvCell(r.text)}`
    );
    const cuerpo = "\uFEFF" + [header, ...filas].join("\r\n") + "\r\n";
    descargarBlob(cuerpo, "text/csv;charset=utf-8", nombreArchivo("csv"));
  }

  get totalLineas() {
    return this.registros.length;
  }

  _stamp() {
    const d = new Date();
    return {
      iso: d.toISOString(),
      hora:
        d.toLocaleTimeString("es-PE", { hour12: false }) +
        "." +
        String(d.getMilliseconds()).padStart(3, "0"),
    };
  }

  _aRegistro(item) {
    const { iso, hora } = this._stamp();
    const text = String(item.text);
    const cls = item.cls || "rx";
    let display = text;
    if (cls === "tx") display = `› ${text.replace(/^›\s*/, "")}`;
    else if (cls === "sys") display = `· ${text}`;
    else if (cls === "ok") display = `✓ ${text}`;
    else if (cls === "warn") display = `! ${text}`;
    else if (cls === "err") display = `× ${text}`;
    if (this.conTimestamp) display = `${hora} ${display}`;
    return { iso, hora, cls, text, display };
  }

  _encolar(item) {
    this.cola.push(item);
    if (this.cola.length > this.maxCola) {
      this._volcarColaARegistros();
    }
    this._programarFlush();
  }

  _volcarColaARegistros() {
    if (!this.cola.length) return;
    const lote = this.cola;
    this.cola = [];
    for (const item of lote) {
      this.registros.push(this._aRegistro(item));
    }
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
        if (this.cola.length || this._pintadoHasta < this.registros.length) this._flush();
      }, 120);
    }
  }

  _flush() {
    this._volcarColaARegistros();
    if (this._query) this._recalcularMatches();
    if (this.pausado) {
      this._emitMetricas();
      if (this._query) this._emitBusqueda();
      return;
    }
    this._pintar({ saltar: false, forzar: false });
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
    for (let i = 0; i < this.registros.length; i++) {
      const lower = this.registros[i].display.toLowerCase();
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

  _pintar({ saltar, forzar }) {
    const nearBottom =
      this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 80;
    const q = this._query;
    const usarMarcas = Boolean(q) && this.registros.length <= 4000;

    if (usarMarcas) {
      this._pintarConMarcas();
      this._pintadoHasta = this.registros.length;
      this._modoMarcas = true;
      if (saltar) this._scrollToCurrentMatch();
      else if (this.autoScroll && nearBottom) {
        this.el.scrollTop = this.el.scrollHeight;
      }
      return;
    }

    const reconstruir = forzar || this._modoMarcas || this._pintadoHasta === 0;
    this._modoMarcas = false;
    if (reconstruir) {
      this.el.textContent = this.registros.map((r) => r.display).join("\n");
      this._pintadoHasta = this.registros.length;
    } else if (this._pintadoHasta < this.registros.length) {
      const extra = this.registros
        .slice(this._pintadoHasta)
        .map((r) => r.display)
        .join("\n");
      const node = this.el.firstChild;
      const prefix = this._pintadoHasta > 0 && extra ? "\n" : "";
      if (node && node.nodeType === Node.TEXT_NODE) {
        node.appendData(prefix + extra);
      } else {
        this.el.textContent = this.registros.map((r) => r.display).join("\n");
      }
      this._pintadoHasta = this.registros.length;
    }

    if (q) this._recalcularMatches();
    if (saltar) this._scrollToCurrentMatch();
    else if (this.autoScroll && nearBottom) {
      this.el.scrollTop = this.el.scrollHeight;
    }
  }

  _pintarConMarcas() {
    const current = this._matchIdx;
    let matchCursor = 0;
    const q = this._query;
    this.el.innerHTML = this.registros
      .map((r, i) => {
        const marked = this._marcarLinea(r.display, q, () => {
          const idx = matchCursor;
          matchCursor += 1;
          return idx === current;
        });
        const cls = marked.hasHit ? "ln has-hit" : "ln";
        return `<div class="${cls}" data-i="${i}">${marked.html}</div>`;
      })
      .join("");
  }

  _marcarLinea(text, query, isCurrentFn) {
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

  _offsetDeLinea(lineIdx, col = 0) {
    let off = 0;
    for (let i = 0; i < lineIdx; i++) {
      off += this.registros[i].display.length + 1;
    }
    return off + col;
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
    if (row) {
      row.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
    const node = this.el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      const ratio = m.line / Math.max(1, this.registros.length - 1);
      this.el.scrollTop = ratio * (this.el.scrollHeight - this.el.clientHeight);
      return;
    }
    const pos = Math.min(this._offsetDeLinea(m.line, m.at), node.length);
    const range = document.createRange();
    range.setStart(node, pos);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    const box = this.el.getBoundingClientRect();
    this.el.scrollTop += rect.top - box.top - box.height * 0.35;
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
      lineas: this.registros.length,
      cola: this.cola.length,
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
