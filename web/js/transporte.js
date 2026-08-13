import { FILTROS_WEB_SERIAL, etiquetaPuerto } from "./catalogo.js";
import { diagnostico } from "./diagnostico.js";
import { esAndroid, TransporteWebUSB } from "./webusb_serial.js";

/**
 * Interfaz común: Web Serial (navegador) o Agente local (pyserial).
 */
export class Transporte {
  async listar() {
    return [];
  }
  async abrir(_id, _config) {}
  async escribir(_bytes) {}
  onDatos(_cb) {}
  onEstado(_cb) {}
  async senales(_s) {}
  async cerrar() {}
  async reengancharRx() {}
  async reabrirPuerto() {}
  get nombre() {
    return "base";
  }
  get conectado() {
    return false;
  }
}

export class TransporteWebSerial extends Transporte {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this._seguir = false;
    this._onDatos = null;
    this._onEstado = null;
    this._lecturaActiva = null;
    this._info = {};
    this._lastConfig = { baudRate: 115200 };
    this._lastTarget = null;
    this._autoReconectar = true;
    this._reconectando = false;
    this._reabriendo = false;
    this._rxCola = [];
    this._rxScheduled = false;
    this._watchdog = null;
    this._ultimoRx = 0;
    this._silencioReenganchado = false;
    this._lecturaGen = 0;
    this._lastReopenAt = 0;
    this._cancelIntencional = false;
    this._doneEspontaneos = 0;

    if (navigator.serial) {
      navigator.serial.addEventListener("connect", (e) => {
        diagnostico.log("usb-connect", {});
        this._emitEstado({ tipo: "hotplug", evento: "connect", port: e.target });
        if (this._autoReconectar) {
          this._intentarReconectar(e.target).catch(() => {});
        }
      });
      navigator.serial.addEventListener("disconnect", (e) => {
        diagnostico.log("usb-disconnect", {});
        if (e.target === this.port || this._mismoPuerto(e.target, this.port)) {
          this._emitEstado({ tipo: "desconectado", motivo: "dispositivo desenchufado" });
          this._cerrarSuave(false).catch(() => {});
        }
      });
    }
  }

  get nombre() {
    return "web-serial";
  }

  get conectado() {
    return Boolean(this.port && this._seguir && this.writer);
  }

  set autoReconectar(v) {
    this._autoReconectar = Boolean(v);
  }

  static disponible() {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  _mismoPuerto(a, b) {
    if (!a || !b) return false;
    try {
      const ia = a.getInfo?.() || {};
      const ib = b.getInfo?.() || {};
      return ia.usbVendorId === ib.usbVendorId && ia.usbProductId === ib.usbProductId;
    } catch {
      return false;
    }
  }

  _emitEstado(payload) {
    this._onEstado?.(payload);
  }

  onDatos(cb) {
    this._onDatos = cb;
  }

  onEstado(cb) {
    this._onEstado = cb;
  }

  async listar() {
    if (!TransporteWebSerial.disponible()) return [];
    const ports = await navigator.serial.getPorts();
    return ports.map((p, i) => {
      const info = p.getInfo();
      return {
        id: `ws-${i}`,
        portRef: p,
        etiqueta: etiquetaPuerto(info),
        ...info,
      };
    });
  }

  async pedirPuerto(opts = {}) {
    if (!TransporteWebSerial.disponible()) {
      throw new Error("Este navegador no soporta Web Serial API");
    }
    // En Android los filtros ocultan CH340 (no es CDC). Sin filtros o WebUSB.
    const req =
      opts.sinFiltros || esAndroid()
        ? {}
        : { filters: FILTROS_WEB_SERIAL };
    const port = await navigator.serial.requestPort(req);
    this._info = port.getInfo();
    return {
      id: "ws-selected",
      portRef: port,
      etiqueta: etiquetaPuerto(this._info),
      _backend: "web-serial",
      ...this._info,
    };
  }

  async abrir(target, config = {}) {
    const baudRate = Number(config.baudRate || 115200);
    const port = target?.portRef || target;
    if (!port) throw new Error("No hay puerto seleccionado");

    this._lastTarget = target?.portRef ? target : { portRef: port };
    this._lastConfig = { ...config, baudRate, bufferSize: config.bufferSize || 65536 };

    await this._cerrarSuave(true);

    this.port = port;
    this._info = port.getInfo?.() || {};

    try {
      if (this.port.readable || this.port.writable) {
        await this.port.close();
      }
    } catch (_) {}

    await this.port.open({
      baudRate,
      dataBits: config.dataBits || 8,
      stopBits: config.stopBits || 1,
      parity: config.parity || "none",
      flowControl: config.flowControl || "none",
      bufferSize: this._lastConfig.bufferSize,
    });

    // Evita mantener DTR/RTS activos (algunos CH340/CDC se quedan raros)
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (_) {}

    this.writer = this.port.writable.getWriter();
    this._seguir = true;
    this._ultimoRx = Date.now();
    this._silencioReenganchado = false;
    this._lecturaGen += 1;
    const gen = this._lecturaGen;
    this._lecturaActiva = this._bucleLectura(gen);
    this._iniciarWatchdog();

    diagnostico.setConexion({
      conectado: true,
      transporte: this.nombre,
      baud: baudRate,
      etiqueta: etiquetaPuerto(this._info),
      vid: this._info.usbVendorId ?? null,
      pid: this._info.usbProductId ?? null,
      bucleLecturaVivo: true,
    });
    diagnostico.actualizarPortFlags(this.port);

    this._emitEstado({
      tipo: "conectado",
      etiqueta: etiquetaPuerto(this._info),
      transporte: this.nombre,
    });
  }

  _encolarRx(value) {
    const copy = value.slice();
    this._rxCola.push(copy);
    this._ultimoRx = Date.now();
    this._silencioReenganchado = false;
    diagnostico.noteChunk(copy);

    if (this._rxCola.length > 500) {
      const drop = this._rxCola.length - 500;
      this._rxCola.splice(0, drop);
      diagnostico.noteDescarte(drop);
      this._emitEstado({
        tipo: "rx-descartado",
        mensaje: `Cola RX saturada: se descartaron ${drop} chunks (UI lenta)`,
      });
    }
    if (!this._rxScheduled) {
      this._rxScheduled = true;
      queueMicrotask(() => this._drenarRx());
    }
  }

  _drenarRx() {
    this._rxScheduled = false;
    if (!this._onDatos) {
      this._rxCola = [];
      return;
    }
    const lote = this._rxCola.splice(0, 32);
    for (const chunk of lote) {
      try {
        this._onDatos(chunk);
      } catch (e) {
        this._emitEstado({ tipo: "error", mensaje: `Handler RX: ${e.message}` });
      }
    }
    if (this._rxCola.length) {
      this._rxScheduled = true;
      setTimeout(() => this._drenarRx(), 0);
    }
  }

  _esErrorCancelacion(err) {
    const msg = String(err?.message || err || "");
    return (
      /Releasing Default reader/i.test(msg) ||
      /Invalid state/i.test(msg) ||
      /The reader is not locked/i.test(msg) ||
      /Cancel/i.test(msg)
    );
  }

  async _bucleLectura(gen) {
    diagnostico.markBucle(true, { gen, fase: "start" });

    while (this.port && this._seguir && gen === this._lecturaGen) {
      diagnostico.actualizarPortFlags(this.port);

      if (!this.port.readable) {
        diagnostico.log("readable-null", { gen });
        this._emitEstado({
          tipo: "error-stream",
          mensaje: "Stream RX null — reabriendo puerto…",
        });
        await this._reabrirPuertoInterno("readable-null");
        return;
      }

      try {
        this.reader = this.port.readable.getReader();
        this._doneEspontaneos = 0;
      } catch (e) {
        diagnostico.noteGetReaderFail(e);
        this._emitEstado({
          tipo: "error-stream",
          mensaje: `getReader falló (${e.name}): reabriendo puerto…`,
        });
        await this._reabrirPuertoInterno("getReader-fail");
        return;
      }

      diagnostico.markBucle(true, { gen, fase: "reading" });
      let salirPorCancel = false;

      try {
        while (this._seguir && gen === this._lecturaGen) {
          const { value, done } = await this.reader.read();
          if (done) {
            // cancel() intencional → done esperado: solo tomar otro reader
            if (this._cancelIntencional) {
              this._cancelIntencional = false;
              salirPorCancel = true;
              diagnostico.log("done-por-cancel", {
                hint: "done esperado tras reenganche; no se reabre el puerto",
              });
              break;
            }

            // done espontáneo: primero reintentar reader; reopen solo si persiste
            this._doneEspontaneos += 1;
            diagnostico.noteDone();
            diagnostico.log("done-espontaneo", { n: this._doneEspontaneos });
            if (this._doneEspontaneos >= 2) {
              this._emitEstado({
                tipo: "error-stream",
                mensaje: "Stream RX done repetido — reabriendo puerto…",
              });
              try {
                this.reader.releaseLock();
              } catch (_) {}
              this.reader = null;
              await this._reabrirPuertoInterno("stream-done-x2");
              return;
            }
            break; // outer loop → nuevo getReader
          }
          if (value?.byteLength) this._encolarRx(value);
        }
      } catch (e) {
        if (this._cancelIntencional || this._esErrorCancelacion(e)) {
          this._cancelIntencional = false;
          salirPorCancel = true;
          diagnostico.log("cancel-esperado", {
            name: e.name,
            message: e.message,
          });
        } else {
          const name = e.name || "Error";
          diagnostico.noteErrorStream(e);
          this._emitEstado({
            tipo: "error-stream",
            mensaje: `RX ${name}: ${e.message || name}`,
          });
          if (name === "NetworkError") {
            await this._cerrarSuave(false);
            diagnostico.markBucle(false, { gen, fase: "network-error" });
            return;
          }
          // BufferOverrun / Framing / Break → liberar y reintentar reader
          diagnostico.noteReenganche(`auto:${name}`);
        }
      } finally {
        try {
          this.reader?.releaseLock();
        } catch (_) {}
        this.reader = null;
        diagnostico.actualizarPortFlags(this.port);
      }

      if (!this._seguir || gen !== this._lecturaGen) break;
      if (salirPorCancel) {
        diagnostico.markBucle(true, { gen, fase: "post-cancel" });
      }
      await this._sleep(10);
    }

    if (gen === this._lecturaGen) {
      diagnostico.markBucle(false, { gen, fase: "exit" });
    }
  }

  /**
   * Cancela SOLO el reader para desbloquear un read() colgado.
   * No hace releaseLock aquí (lo hace el finally del bucle).
   * No reabre el puerto: cancel() produce done y eso antes se malinterpretaba.
   */
  async reengancharRx() {
    if (!this.reader) {
      diagnostico.log("reenganche-sin-reader", {});
      if (this.port && !this.port.readable) {
        await this.reabrirPuerto();
      }
      return;
    }
    diagnostico.noteReenganche("suave");
    this._emitEstado({ tipo: "diag", mensaje: "Reenganche RX suave (cancel reader)…" });
    this._cancelIntencional = true;
    try {
      await this.reader.cancel();
    } catch (e) {
      if (!this._esErrorCancelacion(e)) {
        diagnostico.log("cancel-error", { message: e.message });
      }
    }
    // NO releaseLock aquí — evita TypeError "Releasing Default reader" duplicado
  }

  /** Cierra y vuelve a open() con la misma config — cura stream done. */
  async reabrirPuerto() {
    return this._reabrirPuertoInterno("manual");
  }

  async _reabrirPuertoInterno(motivo) {
    if (this._reabriendo) return;
    if (!this._lastTarget && !this.port) return;
    const elapsed = Date.now() - this._lastReopenAt;
    if (elapsed < 1500) await this._sleep(1500 - elapsed);

    this._reabriendo = true;
    this._lastReopenAt = Date.now();
    diagnostico.noteReapertura(motivo);
    try {
      const target = this._lastTarget || { portRef: this.port };
      const cfg = { ...this._lastConfig };
      this._emitEstado({ tipo: "reconectando", mensaje: `Reabriendo puerto (${motivo})…` });
      await this.abrir(target, cfg);
      this._emitEstado({ tipo: "reconectado", mensaje: `Puerto reabierto (${motivo})` });
    } catch (e) {
      diagnostico.log("reapertura-fail", { motivo, message: e.message });
      this._emitEstado({
        tipo: "error",
        mensaje: `Reapertura falló: ${e.message}. Pulsa Conectar.`,
      });
      diagnostico.markBucle(false, { fase: "reapertura-fail" });
    } finally {
      this._reabriendo = false;
    }
  }

  _iniciarWatchdog() {
    this._pararWatchdog();
    this._watchdog = setInterval(() => {
      if (!this._seguir || !this.port || this._reabriendo) return;
      diagnostico.actualizarPortFlags(this.port);
      const silencio = Date.now() - this._ultimoRx;
      diagnostico.estado.silencioMs = silencio;

      if (silencio > 15000) {
        diagnostico.noteSilencio(silencio);
        this._emitEstado({
          tipo: "rx-silencio",
          mensaje: `Sin datos RX hace ${Math.round(silencio / 1000)}s`,
          silencioMs: silencio,
        });

        // 15s → un solo reenganche suave (cancel reader)
        // 45s → reopen (solo si el suave no recuperó)
        if (silencio > 45000) {
          this._reabrirPuertoInterno("watchdog-45s").catch(() => {});
        } else if (!this._silencioReenganchado) {
          this._silencioReenganchado = true;
          this.reengancharRx().catch(() => {});
        }
      }
    }, 5000);
  }

  _pararWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  async _intentarReconectar(port) {
    if (this._reconectando || this.conectado) return;
    this._reconectando = true;
    try {
      this._emitEstado({ tipo: "reconectando", mensaje: "Dispositivo de nuevo en USB — reconectando…" });
      await this._sleep(450);
      await this.abrir({ portRef: port }, this._lastConfig);
      this._emitEstado({ tipo: "reconectado", mensaje: "Reconectado automáticamente" });
    } catch (e) {
      this._emitEstado({
        tipo: "error",
        mensaje: `Reconexión fallida: ${e.message}. Pulsa Conectar.`,
      });
    } finally {
      this._reconectando = false;
    }
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async escribir(bytes) {
    if (!this.writer) throw new Error("Puerto no abierto");
    const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
    diagnostico.log("tx", { n: data.byteLength });
    await this.writer.write(data);
  }

  async senales(s) {
    if (!this.port) return;
    diagnostico.log("senales", s);
    await this.port.setSignals(s);
  }

  async _cerrarSuave(limpiarPortRef) {
    this._seguir = false;
    this._lecturaGen += 1;
    this._pararWatchdog();
    try {
      await this.reader?.cancel();
    } catch (_) {}
    try {
      this.reader?.releaseLock();
    } catch (_) {}
    try {
      this.writer?.releaseLock();
    } catch (_) {}
    this.reader = null;
    this.writer = null;
    this._rxCola = [];
    if (this.port) {
      try {
        await this.port.close();
      } catch (_) {}
    }
    if (limpiarPortRef) this.port = null;
    diagnostico.setConexion({
      conectado: false,
      bucleLecturaVivo: false,
    });
    diagnostico.actualizarPortFlags(this.port);
  }

  async cerrar() {
    await this._cerrarSuave(true);
    this._emitEstado({ tipo: "cerrado" });
  }
}

export class TransporteAgente extends Transporte {
  constructor(baseUrl = "http://127.0.0.1:8765", token = "ztrack-local") {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws";
    this.token = token;
    this.ws = null;
    this._conectado = false;
    this._onDatos = null;
    this._onEstado = null;
    this._etiqueta = "";
    this._autoReconectar = true;
    this._lastTarget = null;
    this._lastConfig = { baudRate: 115200 };
  }

  get nombre() {
    return "agente";
  }

  get conectado() {
    return this._conectado;
  }

  set autoReconectar(v) {
    this._autoReconectar = Boolean(v);
  }

  onDatos(cb) {
    this._onDatos = cb;
  }

  onEstado(cb) {
    this._onEstado = cb;
  }

  static async detectar(baseUrl = "http://127.0.0.1:8765", timeoutMs = 300) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/salud`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      clearTimeout(t);
      return null;
    }
  }

  async listar() {
    const res = await fetch(`${this.baseUrl}/puertos`, {
      headers: { "X-Agent-Token": this.token },
    });
    if (!res.ok) throw new Error("No se pudo listar puertos del agente");
    return res.json();
  }

  async _ensureWs() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsUrl}?token=${encodeURIComponent(this.token)}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Timeout WebSocket agente"));
      }, 2000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Error conectando al agente local"));
      };
      ws.onmessage = (ev) => this._onMessage(ev);
      ws.onclose = () => {
        this._conectado = false;
        this._onEstado?.({ tipo: "cerrado" });
      };
    });
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.evt === "datos" && msg.b64) {
      const bin = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
      diagnostico.noteChunk(bin, { via: "agente" });
      this._onDatos?.(bin);
    } else if (msg.evt === "estado") {
      this._onEstado?.(msg);
    } else if (msg.evt === "puertos") {
      this._onEstado?.(msg);
      if (this._autoReconectar && this._lastTarget && msg.alta?.length) {
        const ruta = this._lastTarget.ruta || this._lastTarget;
        const match = msg.alta.find((p) => p.ruta === ruta || p.estable === ruta);
        if (match && !this._conectado) {
          this.abrir(match, this._lastConfig).catch(() => {});
        }
      }
    } else if (msg.evt === "error") {
      diagnostico.log("agente-error", { mensaje: msg.mensaje });
      this._onEstado?.({ tipo: "error", mensaje: msg.mensaje });
    }
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Agente no conectado");
    }
    this.ws.send(JSON.stringify(obj));
  }

  async abrir(target, config = {}) {
    await this._ensureWs();
    const ruta = target?.ruta || target?.id || target;
    this._lastTarget = target?.ruta ? target : { ruta };
    this._lastConfig = { ...config, baudRate: Number(config.baudRate || 115200) };
    this._etiqueta = target?.descripcion || target?.etiqueta || ruta;
    this._send({
      cmd: "abrir",
      ruta,
      baudrate: this._lastConfig.baudRate,
      exclusive: true,
    });
    this._conectado = true;
    diagnostico.setConexion({
      conectado: true,
      transporte: this.nombre,
      baud: this._lastConfig.baudRate,
      etiqueta: this._etiqueta,
      bucleLecturaVivo: true,
    });
    this._onEstado?.({
      tipo: "conectado",
      etiqueta: this._etiqueta,
      transporte: this.nombre,
      ruta,
    });
  }

  async escribir(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
    let binary = "";
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
    diagnostico.log("tx", { n: data.byteLength, via: "agente" });
    this._send({ cmd: "escribir", b64: btoa(binary) });
  }

  async senales(s) {
    this._send({ cmd: "senales", ...s });
  }

  async reengancharRx() {
    diagnostico.noteReenganche("manual-agente");
    // El agente no expone reader; reabrir puerto serie
    if (this._lastTarget) await this.abrir(this._lastTarget, this._lastConfig);
  }

  async reabrirPuerto() {
    diagnostico.noteReapertura("manual-agente");
    if (this._lastTarget) await this.abrir(this._lastTarget, this._lastConfig);
  }

  async cerrar() {
    try {
      this._send({ cmd: "cerrar" });
    } catch (_) {}
    try {
      this.ws?.close();
    } catch (_) {}
    this.ws = null;
    this._conectado = false;
    diagnostico.setConexion({ conectado: false, bucleLecturaVivo: false });
    this._onEstado?.({ tipo: "cerrado" });
  }
}

/**
 * Unifica Web Serial (PC) + WebUSB (Android/CH340).
 * En Android Chrome, CH340 no aparece en Web Serial: USB Serial Terminal
 * sí lo ve porque trae driver propio. Aquí usamos WebUSB equivalente.
 */
export class TransporteNavegador extends Transporte {
  constructor() {
    super();
    this.serial = TransporteWebSerial.disponible() ? new TransporteWebSerial() : null;
    this.usb = TransporteWebUSB.disponible() ? new TransporteWebUSB() : null;
    this.activo = null;
    this._onDatos = null;
    this._onEstado = null;
    this._wire(this.serial);
    this._wire(this.usb);
  }

  _wire(t) {
    if (!t) return;
    t.onDatos((b) => this._onDatos?.(b));
    t.onEstado((s) => this._onEstado?.(s));
  }

  get nombre() {
    return this.activo?.nombre || (esAndroid() ? "webusb" : "web-serial");
  }

  get conectado() {
    return Boolean(this.activo?.conectado);
  }

  set autoReconectar(v) {
    if (this.serial) this.serial.autoReconectar = v;
    if (this.usb) this.usb.autoReconectar = v;
  }

  onDatos(cb) {
    this._onDatos = cb;
  }

  onEstado(cb) {
    this._onEstado = cb;
  }

  async listar() {
    const a = this.serial ? await this.serial.listar() : [];
    const b = this.usb ? await this.usb.listar() : [];
    return [...a, ...b];
  }

  async pedirPuerto() {
    const android = esAndroid();
    const errores = [];

    if (android && this.usb) {
      try {
        const p = await this.usb.pedirPuerto();
        this.activo = this.usb;
        p._backend = "webusb";
        return p;
      } catch (e) {
        if (e.name !== "NotFoundError") errores.push(e.message);
      }
    }

    if (this.serial) {
      try {
        const p = await this.serial.pedirPuerto({ sinFiltros: android });
        this.activo = this.serial;
        p._backend = "web-serial";
        return p;
      } catch (e) {
        if (e.name !== "NotFoundError") errores.push(e.message);
      }
    }

    if (!android && this.usb) {
      try {
        const p = await this.usb.pedirPuerto();
        this.activo = this.usb;
        p._backend = "webusb";
        return p;
      } catch (e) {
        if (e.name !== "NotFoundError") errores.push(e.message);
      }
    }

    throw new Error(
      errores[0] ||
        "No se eligió puerto. En Android: Chrome + HTTPS, cierra Serial USB Terminal y acepta el permiso USB OTG."
    );
  }

  _elegirBackend(target) {
    if (target?.device || target?._backend === "webusb") return this.usb;
    if (target?.portRef && target._backend !== "webusb") return this.serial || this.activo;
    return this.activo || (esAndroid() ? this.usb || this.serial : this.serial || this.usb);
  }

  async abrir(target, config) {
    this.activo = this._elegirBackend(target);
    if (!this.activo) throw new Error("Sin transporte USB/Serial");
    return this.activo.abrir(target, config);
  }

  async escribir(bytes) {
    if (!this.activo) throw new Error("Puerto no abierto");
    return this.activo.escribir(bytes);
  }

  async senales(s) {
    return this.activo?.senales?.(s);
  }

  async reengancharRx() {
    return this.activo?.reengancharRx?.();
  }

  async reabrirPuerto() {
    return this.activo?.reabrirPuerto?.();
  }

  async cerrar() {
    await this.activo?.cerrar?.();
  }
}

/**
 * 1) Agente local → 2) Navegador (Serial y/o WebUSB) → 3) ayuda
 */
export async function resolverTransporte() {
  const salud = await TransporteAgente.detectar();
  if (salud) {
    return {
      modo: "agente",
      transporte: new TransporteAgente(),
      detalle: salud,
    };
  }
  const serialOk = TransporteWebSerial.disponible();
  const usbOk = TransporteWebUSB.disponible();
  if (serialOk || usbOk) {
    const modo = esAndroid() && usbOk ? "webusb" : serialOk ? "web-serial" : "webusb";
    return {
      modo,
      transporte: new TransporteNavegador(),
      detalle: {
        navegador: navigator.userAgent,
        android: esAndroid(),
        serial: serialOk,
        webusb: usbOk,
      },
    };
  }
  return { modo: "ninguno", transporte: null, detalle: { android: esAndroid() } };
}
