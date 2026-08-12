/**
 * Detección y asignación de códigos ZG por serial.
 * Compatible con respuestas espontáneas y comandos GET/SET configurables.
 */

/** Coincide ZG001, ZG2608121453040, etc. */
export const RE_CODIGO_ZG = /\bZG[0-9A-Za-z]{3,30}\b/g;

export function extraerCodigos(texto) {
  if (!texto) return [];
  const hallados = texto.match(RE_CODIGO_ZG) || [];
  // únicos, preservando orden
  return [...new Set(hallados)];
}

export function esCodigoGenerado(codigo) {
  // ZG + YYMMDDHHMMSS + correlativo(s)
  return /^ZG\d{13,}$/.test(codigo);
}

export class BufferLineas {
  constructor(onLinea) {
    this.pending = "";
    this.decoder = new TextDecoder();
    this.onLinea = onLinea;
  }

  push(bytes) {
    const chunk = this.decoder.decode(bytes, { stream: true });
    this.pending += chunk;
    const partes = this.pending.split(/\r\n|\n|\r/);
    this.pending = partes.pop() ?? "";
    for (const linea of partes) {
      if (linea.length) this.onLinea(linea);
    }
    return chunk;
  }

  flush() {
    if (this.pending) {
      this.onLinea(this.pending);
      this.pending = "";
    }
  }
}

export class ProtocoloSerie {
  constructor({
    cmdConsultar = "SERIE?",
    cmdAsignar = "SET_SERIE {codigo}",
    terminacion = "\n",
  } = {}) {
    this.cmdConsultar = cmdConsultar;
    this.cmdAsignar = cmdAsignar;
    this.terminacion = terminacion;
    this.codigoDetectado = null;
    this.codigosVistos = [];
    this._waiters = [];
  }

  observarTexto(texto) {
    const codigos = extraerCodigos(texto);
    for (const c of codigos) {
      if (!this.codigosVistos.includes(c)) this.codigosVistos.push(c);
      this.codigoDetectado = c;
      this._resolverEspera(c);
    }
    return codigos;
  }

  _resolverEspera(codigo) {
    const pendientes = this._waiters.splice(0);
    for (const w of pendientes) {
      clearTimeout(w.timer);
      w.resolve(codigo);
    }
  }

  esperarCodigo(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      if (this.codigoDetectado) {
        resolve(this.codigoDetectado);
        return;
      }
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const i = this._waiters.indexOf(waiter);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error("Timeout esperando código por serial"));
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }

  construirConsulta() {
    return this.cmdConsultar + this.terminacion;
  }

  construirAsignacion(codigo) {
    return this.cmdAsignar.replace("{codigo}", codigo) + this.terminacion;
  }
}

/**
 * Llama a la API ZTrack para generar/recuperar código.
 * @param {string} serieOrigen
 * @param {string} apiBase
 * @param {(path:string, opts?:RequestInit)=>Promise<Response>} [fetcher]
 */
export async function generarCodigoApi(serieOrigen, apiBase = "", fetcher = fetch) {
  const base = apiBase.replace(/\/$/, "");
  const url = `${base}/serie/generar/${encodeURIComponent(serieOrigen)}`;
  const res = await fetcher(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API generar falló (${res.status}): ${err}`);
  }
  return res.json();
}
