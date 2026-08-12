/**
 * Consola serial de alto caudal.
 * - RX nunca bloquea el hilo de lectura (cola + drenado por rAF/timer).
 * - Render por lotes con un solo textContent (sin N nodos DOM).
 * - Si hay backlog, descarta lo más antiguo y sigue fluido.
 */

export class ConsolaSerial {
  /**
   * @param {HTMLElement} el
   * @param {{ maxLineas?: number, maxCola?: number, onMetricas?: Function }} opts
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.maxLineas = opts.maxLineas ?? 400;
    this.maxCola = opts.maxCola ?? 2000;
    this.onMetricas = opts.onMetricas || null;

    this.lineas = [];
    this.cola = [];
    this.pausado = false;
    this.autoScroll = true;
    this.conTimestamp = false;

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
    this.el.textContent = "";
    this._emitMetricas(true);
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

  /** Empuja bytes crudos contando métricas (el split de líneas lo hace el caller). */
  contarBytes(n) {
    this._bytesVentana += n;
    this._rxTotal += n;
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
      // Descarta RX antiguos; conserva sys/tx/warn
      let quitados = 0;
      const keep = [];
      for (const it of this.cola) {
        if (quitados < overflow && it.prio === 0) {
          quitados += 1;
          continue;
        }
        keep.push(it);
      }
      // si aún sobra, corta desde el inicio
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
    // Respaldo si la pestaña está en background (rAF se pausa)
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
      // Prefijo visual ligero sin nodos extra
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

    // Un solo rewrite: evita thrashing de layout
    const nearBottom =
      this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 80;
    this.el.textContent = this.lineas.join("\n");
    if (this.autoScroll && nearBottom) {
      this.el.scrollTop = this.el.scrollHeight;
    }

    this._emitMetricas();
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
    // Evita pending infinito si el equipo no manda saltos de línea
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
