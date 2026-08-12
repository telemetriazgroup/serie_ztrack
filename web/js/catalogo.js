/** Catálogo VID/PID → etiqueta legible (Web Serial no da nombres COM/tty). */
export const CATALOGO = {
  "2341": {
    marca: "Arduino",
    modelos: {
      "0043": "Uno R3",
      "0001": "Uno",
      "8036": "Leonardo",
      "0042": "Mega 2560",
    },
  },
  "1a86": {
    marca: "WCH",
    modelos: { "7523": "CH340", "55d4": "CH9102" },
  },
  "10c4": {
    marca: "Silicon Labs",
    modelos: { "ea60": "CP2102 (ESP32)" },
  },
  "0403": {
    marca: "FTDI",
    modelos: { "6001": "FT232R", "6015": "FT231X" },
  },
  "303a": {
    marca: "Espressif",
    modelos: { "1001": "ESP32-S3 USB-CDC" },
  },
  "0483": {
    marca: "STMicro",
    modelos: { "5740": "STM32 CDC", "374b": "ST-Link V3" },
  },
};

export const FILTROS_WEB_SERIAL = [
  { usbVendorId: 0x2341 },
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x0403 },
  { usbVendorId: 0x303a },
  { usbVendorId: 0x0483 },
];

export function etiquetaPuerto(info = {}) {
  const vid = info.usbVendorId?.toString(16).padStart(4, "0");
  const pid = info.usbProductId?.toString(16).padStart(4, "0");
  if (!vid) return info.ruta || info.descripcion || "Puerto serial";
  const e = CATALOGO[vid];
  if (!e) return `USB ${vid}:${pid || "????"}`;
  return `${e.marca} ${e.modelos[pid] ?? pid}`;
}
