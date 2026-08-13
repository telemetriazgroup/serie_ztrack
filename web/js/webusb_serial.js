import { etiquetaPuerto } from "./catalogo.js";
import { diagnostico } from "./diagnostico.js";

export function esAndroid() {
  return /Android/i.test(navigator.userAgent || "");
}

export const FILTROS_WEBUSB = [
  { vendorId: 0x1a86 }, // WCH CH340 / CH341 / CH9102
  { vendorId: 0x10c4 }, // Silicon Labs CP210x
  { vendorId: 0x0403 }, // FTDI
  { vendorId: 0x2341 }, // Arduino CDC
  { vendorId: 0x303a }, // Espressif
  { vendorId: 0x0483 }, // STMicro
  { vendorId: 0x1b4f }, // SparkFun
  { vendorId: 0x2e8a }, // Raspberry Pi
  { vendorId: 0x239a }, // Adafruit
];

function ctrlOutVendor(device, request, value, index) {
  return device.controlTransferOut({
    requestType: "vendor",
    recipient: "device",
    request,
    value,
    index,
  });
}

function ctrlInVendor(device, request, value, index, length) {
  return device.controlTransferIn(
    {
      requestType: "vendor",
      recipient: "device",
      request,
      value,
      index,
    },
    length
  );
}

function findBulkEndpoints(device) {
  const ifaces = device.configuration?.interfaces || [];
  for (const iface of ifaces) {
    for (const alt of iface.alternates) {
      let inEp = null;
      let outEp = null;
      for (const ep of alt.endpoints) {
        if (ep.type !== "bulk") continue;
        if (ep.direction === "in") inEp = ep.endpointNumber;
        if (ep.direction === "out") outEp = ep.endpointNumber;
      }
      if (inEp != null && outEp != null) {
        return {
          interfaceNumber: iface.interfaceNumber,
          alternate: alt.alternateSetting,
          classCode: alt.interfaceClass,
          inEp,
          outEp,
        };
      }
    }
  }
  return null;
}

function findCdcInterfaces(device) {
  const ifaces = device.configuration?.interfaces || [];
  let comm = null;
  let data = null;
  for (const iface of ifaces) {
    const alt = iface.alternates[0];
    if (!alt) continue;
    if (alt.interfaceClass === 0x02) comm = iface.interfaceNumber;
    if (alt.interfaceClass === 0x0a) data = iface.interfaceNumber;
  }
  return { comm, data };
}

async function ch340SetBaud(device, baudRate) {
  const BAUDBASE_FACTOR = 1532620800;
  const BAUDBASE_DIVMAX = 3;
  let factor = Math.floor(BAUDBASE_FACTOR / baudRate);
  let divisor = BAUDBASE_DIVMAX;
  while (factor > 0xfff0 && divisor > 0) {
    factor = Math.floor(factor / 8);
    divisor -= 1;
  }
  if (factor > 0xfff0) {
    throw new Error(`Baud ${baudRate} no soportado en CH340`);
  }
  factor = 0x10000 - factor;
  const a = (factor & 0xff00) | divisor;
  const b = factor & 0xff;
  await ctrlOutVendor(device, 0x9a, 0x1312, a);
  await ctrlOutVendor(device, 0x9a, 0x0f2c, b);
}

async function ch340Init(device, baudRate) {
  await ctrlInVendor(device, 0x5f, 0, 0, 2);
  await ctrlOutVendor(device, 0xa1, 0, 0);
  await ch340SetBaud(device, baudRate);
  await ctrlOutVendor(device, 0x9a, 0x2518, 0x0050); // 8N1
  await ctrlInVendor(device, 0x95, 0x0706, 0, 2);
  await ctrlOutVendor(device, 0xa1, 0x501f, 0xd90a);
  await ch340SetBaud(device, baudRate);
  await ctrlOutVendor(device, 0xa4, 0xff, 0);
}

async function cp210xInit(device, baudRate, iface) {
  await device.controlTransferOut({
    requestType: "vendor",
    recipient: "interface",
    request: 0x00, // IFC_ENABLE
    value: 0x0001,
    index: iface,
  });
  const baudBuf = new ArrayBuffer(4);
  new DataView(baudBuf).setUint32(0, baudRate, true);
  await device.controlTransferOut(
    {
      requestType: "vendor",
      recipient: "interface",
      request: 0x1e, // SET_BAUDRATE
      value: 0,
      index: iface,
    },
    baudBuf
  );
  await device.controlTransferOut({
    requestType: "vendor",
    recipient: "interface",
    request: 0x03, // SET_LINE_CTL 8N1
    value: 0x0800,
    index: iface,
  });
  await device.controlTransferOut({
    requestType: "vendor",
    recipient: "interface",
    request: 0x07, // SET_MHS DTR|RTS
    value: 0x0303,
    index: iface,
  });
}

async function cdcInit(device, baudRate, commIface) {
  const line = new ArrayBuffer(7);
  const v = new DataView(line);
  v.setUint32(0, baudRate, true);
  v.setUint8(4, 0); // 1 stop
  v.setUint8(5, 0); // none
  v.setUint8(6, 8);
  await device.controlTransferOut(
    {
      requestType: "class",
      recipient: "interface",
      request: 0x20, // SET_LINE_CODING
      value: 0,
      index: commIface,
    },
    line
  );
  await device.controlTransferOut({
    requestType: "class",
    recipient: "interface",
    request: 0x22, // SET_CONTROL_LINE_STATE
    value: 0x03,
    index: commIface,
  });
}

function chipKind(device) {
  const vid = device.vendorId;
  const pid = device.productId;
  if (vid === 0x1a86) return "ch340";
  if (vid === 0x10c4) return "cp210x";
  if (vid === 0x0403) return "ftdi";
  return `cdc:${vid.toString(16)}:${pid.toString(16)}`;
}

/**
 * Serial por WebUSB (necesario en Android: CH340 no aparece en Web Serial).
 */
export class TransporteWebUSB {
  constructor() {
    this.device = null;
    this._seguir = false;
    this._onDatos = null;
    this._onEstado = null;
    this._inEp = null;
    this._outEp = null;
    this._iface = null;
    this._lecturaActiva = null;
    this._lastConfig = { baudRate: 115200 };
    this._info = {};
    this._autoReconectar = true;
    this._rxLock = false;

    if (navigator.usb) {
      navigator.usb.addEventListener("disconnect", (e) => {
        if (e.device === this.device) {
          this._emitEstado({ tipo: "desconectado", motivo: "USB OTG desenchufado" });
          this.cerrar().catch(() => {});
        }
      });
    }
  }

  get nombre() {
    return "webusb";
  }

  get conectado() {
    return Boolean(this.device?.opened && this._seguir);
  }

  set autoReconectar(v) {
    this._autoReconectar = Boolean(v);
  }

  static disponible() {
    return typeof navigator !== "undefined" && "usb" in navigator;
  }

  onDatos(cb) {
    this._onDatos = cb;
  }

  onEstado(cb) {
    this._onEstado = cb;
  }

  _emitEstado(payload) {
    this._onEstado?.(payload);
  }

  async listar() {
    if (!TransporteWebUSB.disponible()) return [];
    const devices = await navigator.usb.getDevices();
    return devices.map((d, i) => this._wrap(d, i));
  }

  _wrap(device, i = 0) {
    const info = { usbVendorId: device.vendorId, usbProductId: device.productId };
    return {
      id: `usb-${i}`,
      portRef: device,
      device,
      etiqueta: etiquetaPuerto(info),
      ...info,
    };
  }

  async pedirPuerto() {
    if (!TransporteWebUSB.disponible()) {
      throw new Error("Este navegador no soporta WebUSB (usa Chrome/Edge Android)");
    }
    const device = await navigator.usb.requestDevice({ filters: FILTROS_WEBUSB });
    this.device = device;
    this._info = { usbVendorId: device.vendorId, usbProductId: device.productId };
    return this._wrap(device, 0);
  }

  async abrir(target, config = {}) {
    const baudRate = Number(config.baudRate || 115200);
    const device = target?.device || target?.portRef || target || this.device;
    if (!device) throw new Error("No hay dispositivo USB seleccionado");

    await this.cerrar({ silencioso: true }).catch(() => {});
    this.device = device;
    this._lastConfig = { baudRate };
    this._info = { usbVendorId: device.vendorId, usbProductId: device.productId };

    try {
      await device.open();
    } catch (e) {
      const msg = String(e.message || e);
      if (/Access denied|claimed|in use|Security/i.test(msg)) {
        throw new Error(
          "USB ocupado. Cierra Serial USB Terminal y cualquier otra app que use el OTG, desenchufa y vuelve a conectar."
        );
      }
      throw e;
    }

    if (device.configuration == null) {
      await device.selectConfiguration(1);
    }

    const eps = findBulkEndpoints(device);
    if (!eps) {
      await device.close().catch(() => {});
      throw new Error("El USB no tiene endpoints bulk (no parece un conversor serial)");
    }

    this._iface = eps.interfaceNumber;
    this._inEp = eps.inEp;
    this._outEp = eps.outEp;

    try {
      await device.claimInterface(this._iface);
    } catch (e) {
      await device.close().catch(() => {});
      throw new Error(
        "No se pudo reclamar la interfaz USB. Cierra Serial USB Terminal / Arduino / otras apps y reintenta."
      );
    }

    const cdc = findCdcInterfaces(device);
    const kind = chipKind(device);
    try {
      if (kind === "ch340") {
        await ch340Init(device, baudRate);
      } else if (kind === "cp210x") {
        await cp210xInit(device, baudRate, this._iface);
      } else if (cdc.comm != null) {
        if (cdc.comm !== this._iface) {
          try {
            await device.claimInterface(cdc.comm);
          } catch (_) {}
        }
        await cdcInit(device, baudRate, cdc.comm);
      } else {
        diagnostico.log("webusb-sin-chip", { kind });
      }
    } catch (e) {
      diagnostico.log("webusb-init-warn", { kind, message: e.message });
    }

    this._seguir = true;
    this._lecturaActiva = this._bucleLectura();
    const etiqueta = etiquetaPuerto(this._info);
    diagnostico.setConexion({
      conectado: true,
      transporte: "webusb",
      baud: baudRate,
      etiqueta,
      vid: device.vendorId,
      pid: device.productId,
      bucleLecturaVivo: true,
    });
    this._emitEstado({
      tipo: "conectado",
      etiqueta: `${etiqueta} (WebUSB OTG)`,
      transporte: this.nombre,
      vid: device.vendorId,
      pid: device.productId,
    });
  }

  async _bucleLectura() {
    while (this.device?.opened && this._seguir) {
      try {
        const r = await this.device.transferIn(this._inEp, 64);
        if (!this._seguir) break;
        if (r.status === "ok" && r.data && r.data.byteLength) {
          const copy = new Uint8Array(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength));
          diagnostico.noteChunk(copy, { via: "webusb" });
          this._onDatos?.(copy);
        } else if (r.status === "stall") {
          await this.device.clearHalt("in", this._inEp).catch(() => {});
        }
      } catch (e) {
        if (!this._seguir) break;
        diagnostico.noteErrorStream(e);
        this._emitEstado({
          tipo: "error-stream",
          mensaje: `WebUSB RX: ${e.message || e.name}`,
        });
        await new Promise((r) => setTimeout(r, 80));
      }
    }
  }

  async escribir(bytes) {
    if (!this.device?.opened || this._outEp == null) throw new Error("USB no abierto");
    const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
    const r = await this.device.transferOut(this._outEp, data);
    if (r.status !== "ok") throw new Error("WebUSB TX falló");
  }

  async senales() {}

  async reengancharRx() {
    diagnostico.noteReenganche("webusb");
  }

  async reabrirPuerto() {
    if (this.device) await this.abrir({ device: this.device }, this._lastConfig);
  }

  async cerrar(opts = {}) {
    this._seguir = false;
    const dev = this.device;
    if (dev?.opened) {
      try {
        if (this._iface != null) await dev.releaseInterface(this._iface);
      } catch (_) {}
      try {
        await dev.close();
      } catch (_) {}
    }
    diagnostico.setConexion({ conectado: false, bucleLecturaVivo: false });
    if (!opts.silencioso) this._emitEstado({ tipo: "cerrado" });
  }
}
