/**
 * Módulo de diagnóstico serial.
 * Acumula eventos, métricas y genera un informe exportable
 * para detectar stalls, overrun, done silencioso y reconexiones.
 */

const MAX_EVENTOS = 300;
const MAX_CHUNKS = 80;

export class DiagnosticoSerial {
  constructor() {
    this.reset();
    this._listeners = new Set();
  }

  reset() {
    this.sesionId = `S-${Date.now().toString(36)}`;
    this.inicio = new Date().toISOString();
    this.eventos = [];
    this.chunks = [];
    this._lastSilencioBucket = -1;
    this.contadores = {
      bytesRx: 0,
      chunksRx: 0,
      erroresStream: 0,
      doneStream: 0,
      reenganches: 0,
      reaperturas: 0,
      descartesCola: 0,
      silencios: 0,
      getReaderFail: 0,
      networkErrors: 0,
    };
    this.estado = {
      conectado: false,
      transporte: null,
      baud: null,
      etiqueta: null,
      vid: null,
      pid: null,
      readerLocked: null,
      writableLocked: null,
      readableNull: null,
      ultimoRxIso: null,
      silencioMs: 0,
      bucleLecturaVivo: false,
      ultimoEventoBucle: null,
    };
    this.hipotesis = [];
  }

  onUpdate(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _notify() {
    for (const cb of this._listeners) {
      try {
        cb(this.snapshot());
      } catch (_) {}
    }
  }

  _pushEvento(tipo, detalle = {}) {
    const ev = {
      t: new Date().toISOString(),
      ts: performance.now(),
      tipo,
      ...detalle,
    };
    this.eventos.push(ev);
    if (this.eventos.length > MAX_EVENTOS) {
      this.eventos.splice(0, this.eventos.length - MAX_EVENTOS);
    }
    this._actualizarHipotesis();
    this._notify();
    return ev;
  }

  log(tipo, detalle) {
    return this._pushEvento(tipo, detalle);
  }

  setConexion(info = {}) {
    Object.assign(this.estado, info);
    this._pushEvento("conexion", info);
  }

  markBucle(estado, extra = {}) {
    this.estado.bucleLecturaVivo = Boolean(estado);
    this.estado.ultimoEventoBucle = { t: new Date().toISOString(), ...extra };
    this._pushEvento("bucle", { vivo: this.estado.bucleLecturaVivo, ...extra });
  }

  noteChunk(bytes, meta = {}) {
    const n = bytes?.byteLength ?? bytes?.length ?? 0;
    this.contadores.bytesRx += n;
    this.contadores.chunksRx += 1;
    this.estado.ultimoRxIso = new Date().toISOString();
    this.estado.silencioMs = 0;

    // muestra compacta hex/ascii de los primeros bytes (para basura ����)
    const sample = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const head = sample.slice(0, 24);
    const hex = [...head].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...head]
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
      .join("");

    this.chunks.push({
      t: this.estado.ultimoRxIso,
      n,
      hex,
      ascii,
      ...meta,
    });
    if (this.chunks.length > MAX_CHUNKS) {
      this.chunks.splice(0, this.chunks.length - MAX_CHUNKS);
    }

    // no notificar en cada chunk (demasiado); solo cada N
    if (this.contadores.chunksRx % 8 === 0) this._notify();
  }

  noteSilencio(ms) {
    this.estado.silencioMs = ms;
    // Evita inundar el log: 1 evento por tramo de ~8s
    const bucket = Math.floor(ms / 8000);
    if (this._lastSilencioBucket === bucket) {
      this._notify();
      return;
    }
    this._lastSilencioBucket = bucket;
    this.contadores.silencios += 1;
    this._pushEvento("silencio", { ms, segundos: Math.round(ms / 1000) });
  }

  noteErrorStream(err) {
    this.contadores.erroresStream += 1;
    const name = err?.name || "Error";
    if (name === "NetworkError") this.contadores.networkErrors += 1;
    this._pushEvento("error-stream", {
      name,
      message: err?.message || String(err),
    });
  }

  noteDone() {
    this.contadores.doneStream += 1;
    this._pushEvento("stream-done", {
      hint: "ReadableStream cerró (done). Suele requerir reabrir el puerto.",
    });
  }

  noteReenganche(motivo) {
    this.contadores.reenganches += 1;
    this._pushEvento("reenganche", { motivo });
  }

  noteReapertura(motivo) {
    this.contadores.reaperturas += 1;
    this._pushEvento("reapertura", { motivo });
  }

  noteGetReaderFail(err) {
    this.contadores.getReaderFail += 1;
    this._pushEvento("getReader-fail", {
      name: err?.name,
      message: err?.message || String(err),
    });
  }

  noteDescarte(n) {
    this.contadores.descartesCola += n;
    this._pushEvento("descarte-cola", { n });
  }

  actualizarPortFlags(port) {
    if (!port) {
      this.estado.readerLocked = null;
      this.estado.writableLocked = null;
      this.estado.readableNull = true;
      return;
    }
    try {
      this.estado.readableNull = !port.readable;
      this.estado.readerLocked = port.readable?.locked ?? null;
      this.estado.writableLocked = port.writable?.locked ?? null;
    } catch (e) {
      this._pushEvento("port-flags-error", { message: e.message });
    }
  }

  _actualizarHipotesis() {
    const h = [];
    const c = this.contadores;
    const s = this.estado;

    if (c.doneStream > 0 && c.reaperturas > c.doneStream) {
      h.push({
        nivel: "alta",
        msg: "Más reaperturas que done: posible tormenta de recuperación (OBS-01/05). Actualiza y revalida.",
      });
    }
    if (c.doneStream > 0 && c.reaperturas === 0) {
      h.push({
        nivel: "media",
        msg: "Hubo done de stream pero sin reapertura. Si fue por cancel de reenganche, es normal (done-por-cancel).",
      });
    }
    const cancelEsp = this.eventos.filter((e) => e.tipo === "done-por-cancel" || e.tipo === "cancel-esperado").length;
    if (cancelEsp > 0) {
      h.push({
        nivel: "ok",
        msg: `Cancelaciones controladas: ${cancelEsp}. Ya no deben disparar reopen.`,
      });
    }
    if (c.getReaderFail > 0) {
      h.push({
        nivel: "alta",
        msg: "getReader() falló: el ReadableStream quedó inválido. Solución: cerrar y volver a open().",
      });
    }
    if (s.silencioMs > 12000 && s.conectado && s.bucleLecturaVivo) {
      h.push({
        nivel: "media",
        msg: "Bucle vivo pero sin RX: posible read() colgado o equipo en silencio real. Probar reenganche forzado.",
      });
    }
    if (s.silencioMs > 12000 && s.conectado && !s.bucleLecturaVivo) {
      h.push({
        nivel: "alta",
        msg: "Bucle de lectura muerto con sesión 'conectada'. Bug de recuperación — usar Reabrir puerto.",
      });
    }
    if (c.erroresStream > 2) {
      h.push({
        nivel: "media",
        msg: "Varios errores de stream (overrun/framing). Sube bufferSize, reduce carga UI o baja baud si hay cable largo.",
      });
    }
    const basura = this.chunks.some((ch) => /[^\x09\x0a\x0d\x20-\x7e]/.test(ch.ascii.replace(/\./g, "")));
    // chunks with many '.' from non-ascii
    const muchosPuntos = this.chunks.slice(0, 5).filter((ch) => (ch.ascii.match(/\./g) || []).length >= 3);
    if (muchosPuntos.length >= 1) {
      h.push({
        nivel: "baja",
        msg: "Bytes no ASCII al inicio (����): típico de reset DTR/boot o basura al abrir. No suele ser fatal.",
      });
    }
    if (c.networkErrors > 0) {
      h.push({
        nivel: "alta",
        msg: "NetworkError: desconexión USB física o driver CH340 soltó el puerto.",
      });
    }
    if (!h.length && s.conectado) {
      h.push({ nivel: "ok", msg: "Sin anomalías claras todavía. Observa contadores tras 1 minuto de RX." });
    }
    this.hipotesis = h;
  }

  snapshot() {
    return {
      sesionId: this.sesionId,
      inicio: this.inicio,
      navegador: navigator.userAgent,
      secureContext: window.isSecureContext,
      contadores: { ...this.contadores },
      estado: { ...this.estado },
      hipotesis: [...this.hipotesis],
      eventosRecientes: this.eventos.slice(-40),
      chunksRecientes: this.chunks.slice(-20),
    };
  }

  informeTexto() {
    const s = this.snapshot();
    const lines = [
      "=== ZTrack Serial Diagnóstico ===",
      `Sesión: ${s.sesionId}`,
      `Inicio: ${s.inicio}`,
      `Export: ${new Date().toISOString()}`,
      `UA: ${s.navegador}`,
      `SecureContext: ${s.secureContext}`,
      "",
      "-- Estado --",
      JSON.stringify(s.estado, null, 2),
      "",
      "-- Contadores --",
      JSON.stringify(s.contadores, null, 2),
      "",
      "-- Hipótesis --",
      ...s.hipotesis.map((h) => `[${h.nivel}] ${h.msg}`),
      "",
      "-- Eventos (últimos) --",
      ...s.eventosRecientes.map((e) => `${e.t} ${e.tipo} ${JSON.stringify(e)}`),
      "",
      "-- Chunks (muestra) --",
      ...s.chunksRecientes.map((c) => `${c.t} n=${c.n} ascii="${c.ascii}" hex=${c.hex}`),
    ];
    return lines.join("\n");
  }

  exportarJSON() {
    return JSON.stringify(this.snapshot(), null, 2);
  }
}

export const diagnostico = new DiagnosticoSerial();
