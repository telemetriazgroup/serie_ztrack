import { apiFetch, obtenerGeoLugar } from "./auth.js";

/**
 * Captura eventos RX/TX de la sesión serial y los envía a la API en lotes.
 */
export class SesionTracker {
  constructor() {
    this.sesionId = null;
    this.cola = [];
    this.timer = null;
    this.codigoDetectado = null;
    this.codigoAsignado = null;
    this.flushMs = 2500;
    this.maxCola = 400;
  }

  async iniciar(dispositivo = {}) {
    await this.cerrar("cambio de dispositivo");
    const geo = await obtenerGeoLugar();
    const res = await apiFetch("/sesiones-serial/iniciar", {
      method: "POST",
      body: JSON.stringify({
        dispositivo_etiqueta: dispositivo.etiqueta || null,
        dispositivo_vid: dispositivo.vid ?? dispositivo.usbVendorId ?? null,
        dispositivo_pid: dispositivo.pid ?? dispositivo.usbProductId ?? null,
        dispositivo_ruta: dispositivo.ruta || null,
        baudrate: dispositivo.baudrate || 115200,
        lugar: geo.lugar,
        latitud: geo.latitud,
        longitud: geo.longitud,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`No se pudo iniciar sesión serial: ${err}`);
    }
    const data = await res.json();
    this.sesionId = data.id;
    this._schedule();
    return data;
  }

  push(tipo, contenido) {
    if (!this.sesionId || !contenido) return;
    this.cola.push({ tipo, contenido: String(contenido).slice(0, 4000) });
    if (this.cola.length >= this.maxCola) {
      this.flush().catch(() => {});
    }
  }

  setCodigoDetectado(c) {
    if (c) this.codigoDetectado = c;
  }

  setCodigoAsignado(c) {
    if (c) this.codigoAsignado = c;
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushMs);
  }

  async flush() {
    if (!this.sesionId || !this.cola.length) return;
    const lote = this.cola.splice(0, this.maxCola);
    const res = await apiFetch(`/sesiones-serial/${this.sesionId}/append`, {
      method: "POST",
      body: JSON.stringify({
        eventos: lote,
        codigo_detectado: this.codigoDetectado,
        codigo_asignado: this.codigoAsignado,
      }),
    });
    if (!res.ok && res.status !== 401) {
      // reencola si falla temporalmente
      this.cola.unshift(...lote);
    }
  }

  async cerrar(nota = null) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.sesionId) return;
    try {
      await this.flush();
      await apiFetch(`/sesiones-serial/${this.sesionId}/cerrar`, {
        method: "POST",
        body: JSON.stringify({
          nota,
          codigo_detectado: this.codigoDetectado,
          codigo_asignado: this.codigoAsignado,
        }),
      });
    } catch (_) {}
    this.sesionId = null;
    this.cola = [];
  }
}
