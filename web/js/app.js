import { resolverTransporte, TransporteAgente } from "./transporte.js";
import { ConsolaSerial, DecodificadorLineas } from "./consola.js";
import { diagnostico } from "./diagnostico.js";
import { apiFetch, isSuperusuario, logout, requireAuth } from "./auth.js";
import { SesionTracker } from "./sesion_tracker.js";
import {
  ProtocoloSerie,
  generarCodigoApi,
  esCodigoGenerado,
  extraerCodigos,
} from "./protocolo.js";

const $ = (sel) => document.querySelector(sel);

const ui = {
  modo: $("#modo-transporte"),
  estado: $("#estado-conexion"),
  puertoLabel: $("#puerto-label"),
  selectPuerto: $("#select-puerto"),
  baud: $("#baudrate"),
  btnElegir: $("#btn-elegir"),
  btnConectar: $("#btn-conectar"),
  btnDesconectar: $("#btn-desconectar"),
  btnRefresh: $("#btn-refresh-puertos"),
  consola: $("#consola"),
  inputTx: $("#input-tx"),
  btnEnviar: $("#btn-enviar"),
  autoScroll: $("#auto-scroll"),
  btnLimpiar: $("#btn-limpiar"),
  btnPausa: $("#btn-pausa"),
  codigoDetectado: $("#codigo-detectado"),
  codigoNuevo: $("#codigo-nuevo"),
  mensajeAsignacion: $("#mensaje-asignacion"),
  btnConsultar: $("#btn-consultar-serie"),
  btnGenerar: $("#btn-generar-asignar"),
  btnSoloGenerar: $("#btn-solo-generar"),
  cmdConsultar: $("#cmd-consultar"),
  cmdAsignar: $("#cmd-asignar"),
  ayuda: $("#panel-ayuda"),
  avisoSeguro: $("#aviso-contexto"),
  chkTimestamp: $("#chk-timestamp"),
  chkReconectar: $("#chk-reconectar"),
  dtrWarn: $("#dtr-warn"),
  rxMeter: $("#rx-meter"),
  diagHipotesis: $("#diag-hipotesis"),
  diagContadores: $("#diag-contadores"),
  diagEstado: $("#diag-estado"),
  diagEventos: $("#diag-eventos"),
  btnReenganche: $("#btn-reenganche"),
  btnReabrir: $("#btn-reabrir"),
  btnDiagCopy: $("#btn-diag-copy"),
  btnDiagExport: $("#btn-diag-export"),
  btnDiagReset: $("#btn-diag-reset"),
  panelDiag: $("#panel-diag"),
  userPill: $("#user-pill"),
  navUsers: $("#nav-users"),
  btnLogout: $("#btn-logout"),
};

let transporte = null;
let modo = "ninguno";
let protocolo = new ProtocoloSerie();
let decoder = new DecodificadorLineas();
let consola = null;
let puertoWebElegido = null;
let lastCodigoUi = "";
let lastCodigoUiAt = 0;
let lastSilencioLog = 0;
const tracker = new SesionTracker();
let currentUser = null;

function esContextoSeguro() {
  return window.isSecureContext;
}

function hora() {
  return new Date().toLocaleTimeString("es-PE", { hour12: false });
}

function logSistema(msg, cls = "sys") {
  consola?.log(`[${hora()}] ${msg}`, cls);
}

function setEstado(texto, ok = false) {
  ui.estado.textContent = texto;
  ui.estado.dataset.ok = ok ? "1" : "0";
}

function actualizarProtocolo() {
  protocolo = new ProtocoloSerie({
    cmdConsultar: ui.cmdConsultar.value.trim() || "SERIE?",
    cmdAsignar: ui.cmdAsignar.value.trim() || "SET_SERIE {codigo}",
    terminacion: "\n",
  });
}

function actualizarCodigoUi(codigo) {
  if (!codigo) return;
  const now = Date.now();
  // Evita reflows/animaciones en cada línea con el mismo código
  if (codigo === lastCodigoUi && now - lastCodigoUiAt < 2000) return;
  lastCodigoUi = codigo;
  lastCodigoUiAt = now;
  ui.codigoDetectado.value = codigo;
  tracker.setCodigoDetectado(codigo);
}

async function init() {
  currentUser = await requireAuth();
  if (!currentUser) return;

  if (ui.userPill) ui.userPill.textContent = `${currentUser.username} · ${currentUser.rol}`;
  if (currentUser.rol === "superusuario") {
    if (ui.navUsers) ui.navUsers.hidden = false;
    if (ui.panelDiag) ui.panelDiag.hidden = false;
  }

  ui.btnLogout?.addEventListener("click", () => {
    tracker.cerrar("logout").finally(() => logout());
  });
  window.addEventListener("beforeunload", () => {
    tracker.cerrar("navegacion");
  });

  consola = new ConsolaSerial(ui.consola, {
    maxLineas: 400,
    maxCola: 2500,
    onMetricas: (m) => {
      if (!ui.rxMeter) return;
      const drop = m.descartadas ? ` · ↓${m.descartadas}` : "";
      const pause = m.pausado ? " · PAUSA" : "";
      ui.rxMeter.textContent = `${m.bps} B/s · ${m.lineas} líneas${drop}${pause}`;
      ui.rxMeter.dataset.alive = m.bps > 0 ? "1" : "0";
    },
  });

  if (!esContextoSeguro()) {
    ui.avisoSeguro.hidden = false;
  }

  const resolved = await resolverTransporte();
  modo = resolved.modo;
  transporte = resolved.transporte;

  if (modo === "agente") {
    ui.modo.textContent = "Agente local (puertos reales)";
    ui.modo.dataset.mode = "agente";
    ui.selectPuerto.hidden = false;
    ui.btnRefresh.hidden = false;
    ui.btnElegir.hidden = true;
    await refrescarPuertosAgente();
  } else if (modo === "web-serial") {
    ui.modo.textContent = "Web Serial (navegador)";
    ui.modo.dataset.mode = "web";
    ui.selectPuerto.hidden = true;
    ui.btnRefresh.hidden = true;
    ui.btnElegir.hidden = false;
    ui.ayuda.querySelector("[data-web]").hidden = false;
  } else {
    ui.modo.textContent = "Sin transporte serial";
    ui.modo.dataset.mode = "none";
    ui.ayuda.hidden = false;
    ui.btnElegir.disabled = true;
    ui.btnConectar.disabled = true;
    setEstado("Navegador sin Web Serial y sin agente local");
    return;
  }

  wireTransporte();
  wireUi();
  wireDiagnostico();
  setEstado(`Listo · modo ${modo}`);
  detectarMovil();
  renderDiagnostico(diagnostico.snapshot());
}

function detectarMovil() {
  const movil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (movil) {
    const tip = $("#tip-movil");
    if (tip) tip.hidden = false;
  }
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    logSistema("iOS/Safari no soporta Web Serial. Usa Chrome en Android con USB-OTG, o un PC.", "warn");
  }
}

function wireTransporte() {
  transporte.autoReconectar = ui.chkReconectar?.checked ?? true;

  transporte.onDatos((bytes) => {
    consola.contarBytes(bytes.byteLength || bytes.length || 0);
    const [lineas, chunk] = decoder.push(bytes);

    // Detección de código solo en líneas completas (barato)
    if (Array.isArray(lineas)) {
      for (const linea of lineas) {
        consola.rxLinea(linea);
        tracker.push("rx", linea);
        const codigos = protocolo.observarTexto(linea);
        if (codigos.length) actualizarCodigoUi(protocolo.codigoDetectado || codigos[0]);
      }
    }

    // Fallback: chunk sin newline todavía puede traer ZG…
    if (typeof chunk === "string" && chunk.includes("ZG")) {
      const codigos = extraerCodigos(chunk);
      if (codigos.length) {
        protocolo.observarTexto(codigos[codigos.length - 1]);
        actualizarCodigoUi(codigos[codigos.length - 1]);
      }
    }
  });

  transporte.onEstado((st) => {
    if (st.tipo === "conectado" || st.tipo === "reconectado") {
      setEstado(`Conectado · ${st.etiqueta || ui.puertoLabel.textContent || ""}`, true);
      if (st.etiqueta) ui.puertoLabel.textContent = st.etiqueta;
      ui.btnConectar.disabled = true;
      ui.btnDesconectar.disabled = false;
      ui.dtrWarn.hidden = false;
      decoder = new DecodificadorLineas();
      if (st.tipo === "reconectado") {
        logSistema(st.mensaje || "Reconectado", "ok");
      }
      // Una sesión BD por conexión de usuario; reopens del puerto reutilizan la misma
      if (!tracker.sesionId) {
        const baudrate = Number(ui.baud.value);
        tracker
          .iniciar({
            etiqueta: st.etiqueta || ui.puertoLabel.textContent,
            vid: st.vid,
            pid: st.pid,
            usbVendorId: puertoWebElegido?.usbVendorId,
            usbProductId: puertoWebElegido?.usbProductId,
            ruta: st.ruta,
            baudrate,
          })
          .then((s) => logSistema(`Sesión serial #${s.id} iniciada (usuario ${currentUser.username})`, "ok"))
          .catch((e) => logSistema(e.message, "err"));
      }
    } else if (st.tipo === "reconectando") {
      setEstado("Reconectando…");
      logSistema(st.mensaje || "Reconectando…", "warn");
    } else if (st.tipo === "cerrado" || st.tipo === "desconectado") {
      setEstado(st.motivo ? `Desconectado: ${st.motivo}` : "Desconectado");
      ui.btnConectar.disabled = false;
      ui.btnDesconectar.disabled = true;
      ui.dtrWarn.hidden = true;
      if (st.motivo) logSistema(st.motivo, "warn");
      tracker.cerrar(st.motivo || "desconectado").catch(() => {});
    } else if (st.tipo === "error-stream" || st.tipo === "diag") {
      logSistema(st.mensaje, "warn");
      tracker.push("warn", st.mensaje);
    } else if (st.tipo === "rx-descartado") {
      logSistema(st.mensaje, "warn");
    } else if (st.tipo === "rx-silencio") {
      const now = Date.now();
      if (now - lastSilencioLog > 12000) {
        lastSilencioLog = now;
        const tip = isSuperusuario()
          ? `${st.mensaje} · mira Diagnóstico`
          : st.mensaje;
        logSistema(tip, "sys");
      }
    } else if (st.tipo === "error") {
      logSistema(st.mensaje, "err");
      tracker.push("err", st.mensaje);
    } else if (st.evt === "puertos") {
      refrescarPuertosAgente().catch(() => {});
    }
  });
}

function wireDiagnostico() {
  if (!isSuperusuario()) return;
  diagnostico.onUpdate((snap) => renderDiagnostico(snap));

  ui.btnReenganche?.addEventListener("click", async () => {
    try {
      await transporte.reengancharRx();
      logSistema("Reenganche RX solicitado", "warn");
    } catch (e) {
      logSistema(`Reenganche falló: ${e.message}`, "err");
    }
  });

  ui.btnReabrir?.addEventListener("click", async () => {
    try {
      await transporte.reabrirPuerto();
      logSistema("Reapertura de puerto solicitada", "warn");
    } catch (e) {
      logSistema(`Reabrir falló: ${e.message}`, "err");
    }
  });

  ui.btnDiagCopy?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(diagnostico.informeTexto());
      logSistema("Informe de diagnóstico copiado al portapapeles", "ok");
    } catch (e) {
      logSistema(`No se pudo copiar: ${e.message}`, "err");
    }
  });

  ui.btnDiagExport?.addEventListener("click", () => {
    const blob = new Blob([diagnostico.exportarJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ztrack-serial-diag-${diagnostico.sesionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    logSistema("JSON de diagnóstico descargado", "ok");
  });

  ui.btnDiagReset?.addEventListener("click", () => {
    diagnostico.reset();
    renderDiagnostico(diagnostico.snapshot());
    logSistema("Diagnóstico reiniciado", "sys");
  });
}

function renderDiagnostico(snap) {
  if (!ui.diagContadores) return;

  ui.diagContadores.textContent =
    `bytesRx: ${snap.contadores.bytesRx}\n` +
    `chunksRx: ${snap.contadores.chunksRx}\n` +
    `erroresStream: ${snap.contadores.erroresStream}\n` +
    `doneStream: ${snap.contadores.doneStream}\n` +
    `getReaderFail: ${snap.contadores.getReaderFail}\n` +
    `reenganches: ${snap.contadores.reenganches}\n` +
    `reaperturas: ${snap.contadores.reaperturas}\n` +
    `networkErrors: ${snap.contadores.networkErrors}\n` +
    `descartesCola: ${snap.contadores.descartesCola}\n` +
    `silencios: ${snap.contadores.silencios}`;

  ui.diagEstado.textContent =
    `conectado: ${snap.estado.conectado}\n` +
    `transporte: ${snap.estado.transporte}\n` +
    `baud: ${snap.estado.baud}\n` +
    `vid:pid: ${snap.estado.vid ?? "-"}:${snap.estado.pid ?? "-"}\n` +
    `bucleVivo: ${snap.estado.bucleLecturaVivo}\n` +
    `readableNull: ${snap.estado.readableNull}\n` +
    `readerLocked: ${snap.estado.readerLocked}\n` +
    `writableLocked: ${snap.estado.writableLocked}\n` +
    `silencioMs: ${snap.estado.silencioMs}\n` +
    `ultimoRx: ${snap.estado.ultimoRxIso || "—"}\n` +
    `bucle: ${JSON.stringify(snap.estado.ultimoEventoBucle || {})}`;

  ui.diagHipotesis.innerHTML = "";
  for (const h of snap.hipotesis) {
    const div = document.createElement("div");
    div.className = "hip";
    div.dataset.nivel = h.nivel;
    div.textContent = h.msg;
    ui.diagHipotesis.appendChild(div);
  }

  const evs = snap.eventosRecientes.slice().reverse();
  ui.diagEventos.textContent = evs
    .slice(0, 35)
    .map((e) => {
      const { t, tipo, ts, ...rest } = e;
      const hora = t?.slice(11, 19) || "";
      return `${hora} ${tipo} ${JSON.stringify(rest)}`;
    })
    .join("\n");
}

function wireUi() {
  ui.autoScroll?.addEventListener("change", () => {
    consola.setAutoScroll(ui.autoScroll.checked);
  });
  ui.chkTimestamp?.addEventListener("change", () => {
    consola.setTimestamp(ui.chkTimestamp.checked);
  });
  ui.chkReconectar?.addEventListener("change", () => {
    if (transporte) transporte.autoReconectar = ui.chkReconectar.checked;
  });
  consola.setAutoScroll(ui.autoScroll?.checked ?? true);
  consola.setTimestamp(ui.chkTimestamp?.checked ?? false);
}

async function refrescarPuertosAgente() {
  if (!(transporte instanceof TransporteAgente)) return;
  const lista = await transporte.listar();
  ui.selectPuerto.innerHTML = "";
  if (!lista.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No hay puertos detectados";
    ui.selectPuerto.appendChild(opt);
    return;
  }
  for (const p of lista) {
    const opt = document.createElement("option");
    opt.value = p.ruta;
    opt.textContent = `${p.ruta} — ${p.descripcion || p.etiqueta || ""}`;
    opt.dataset.json = JSON.stringify(p);
    ui.selectPuerto.appendChild(opt);
  }
}

ui.btnElegir?.addEventListener("click", async () => {
  try {
    puertoWebElegido = await transporte.pedirPuerto();
    ui.puertoLabel.textContent = puertoWebElegido.etiqueta;
    logSistema(`Puerto autorizado: ${puertoWebElegido.etiqueta}`);
    setEstado("Puerto elegido · pulsa Conectar");
  } catch (e) {
    if (e.name !== "NotFoundError") {
      logSistema(`Selección cancelada o fallida: ${e.message}`, "warn");
    }
  }
});

ui.btnRefresh?.addEventListener("click", () => {
  refrescarPuertosAgente().catch((e) => logSistema(e.message, "err"));
});

ui.btnConectar?.addEventListener("click", async () => {
  try {
    const baudRate = Number(ui.baud.value);
    if (modo === "web-serial") {
      if (!puertoWebElegido) {
        puertoWebElegido = await transporte.pedirPuerto();
        ui.puertoLabel.textContent = puertoWebElegido.etiqueta;
      }
      await transporte.abrir(puertoWebElegido, { baudRate, bufferSize: 65536 });
    } else {
      const opt = ui.selectPuerto.selectedOptions[0];
      if (!opt?.value) throw new Error("Selecciona un puerto");
      const target = JSON.parse(opt.dataset.json);
      await transporte.abrir(target, { baudRate });
    }
    logSistema(`Abierto a ${baudRate} baud · buffer ampliado · render por lotes`);
  } catch (e) {
    logSistema(`No se pudo abrir: ${e.message}`, "err");
    if (/NetworkError|Failed to open|Access denied|Permission|already open/i.test(e.message)) {
      logSistema("¿El puerto está ocupado por Arduino IDE / screen / otro monitor?", "warn");
    }
  }
});

ui.btnDesconectar?.addEventListener("click", async () => {
  await transporte.cerrar();
  logSistema("Puerto cerrado");
});

ui.btnPausa?.addEventListener("click", () => {
  const next = !consola.pausado;
  consola.setPausado(next);
  ui.btnPausa.textContent = next ? "Reanudar vista" : "Pausar vista";
  ui.btnPausa.dataset.on = next ? "1" : "0";
  logSistema(next ? "Vista en pausa (RX sigue en background descartando display)" : "Vista reanudada", "sys");
});

ui.btnEnviar?.addEventListener("click", enviarTx);
ui.inputTx?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    enviarTx();
  }
});

async function enviarTx() {
  if (!transporte?.conectado) {
    logSistema("Conecta un puerto primero", "warn");
    return;
  }
  const text = ui.inputTx.value;
  if (!text) return;
  const line = text.endsWith("\n") ? text : text + "\n";
  try {
    await transporte.escribir(line);
    consola.log(text, "tx");
    tracker.push("tx", text);
    ui.inputTx.value = "";
  } catch (e) {
    logSistema(`TX falló: ${e.message}`, "err");
  }
}

ui.btnLimpiar?.addEventListener("click", () => {
  consola.limpiar();
});

ui.btnConsultar?.addEventListener("click", async () => {
  if (!transporte?.conectado) {
    logSistema("Conecta el equipo primero", "warn");
    return;
  }
  actualizarProtocolo();
  protocolo.codigoDetectado = null;
  const cmd = protocolo.construirConsulta();
  try {
    await transporte.escribir(cmd);
    consola.log(cmd.trim(), "tx");
    logSistema("Consultando serie al dispositivo…");
    const codigo = await protocolo.esperarCodigo(5000);
    actualizarCodigoUi(codigo);
    logSistema(`Código detectado: ${codigo}`, "ok");
  } catch (e) {
    logSistema(e.message, "warn");
    logSistema("También puedes escribir el código manualmente si el firmware no responde a SERIE?", "sys");
  }
});

ui.btnSoloGenerar?.addEventListener("click", async () => {
  await flujoGenerar(false);
});

ui.btnGenerar?.addEventListener("click", async () => {
  await flujoGenerar(true);
});

async function flujoGenerar(escribirAlDispositivo) {
  actualizarProtocolo();
  const origen = (ui.codigoDetectado.value || "").trim();
  if (!origen) {
    ui.mensajeAsignacion.textContent = "Primero detecta o escribe el código actual del equipo (ej. ZG001).";
    ui.mensajeAsignacion.dataset.kind = "warn";
    return;
  }

  ui.mensajeAsignacion.textContent = "Generando código en API…";
  ui.mensajeAsignacion.dataset.kind = "sys";
  ui.btnGenerar.disabled = true;
  ui.btnSoloGenerar.disabled = true;

  try {
    const resp = await generarCodigoApi(origen, "", apiFetch);
    ui.codigoNuevo.value = resp.codigo;
    tracker.setCodigoAsignado(resp.codigo);
    const msg = resp.ya_asignado
      ? `Ya asignado: ${resp.codigo}`
      : `Nuevo código: ${resp.codigo}`;
    ui.mensajeAsignacion.textContent = resp.mensaje || msg;
    ui.mensajeAsignacion.dataset.kind = resp.ya_asignado ? "warn" : "ok";
    logSistema(`${msg} (origen ${resp.serie_origen})`, resp.ya_asignado ? "warn" : "ok");

    if (escribirAlDispositivo) {
      if (!transporte?.conectado) {
        throw new Error("Conecta el serial para escribir el código al equipo");
      }
      if (esCodigoGenerado(origen) && origen === resp.codigo) {
        logSistema("El equipo ya tiene este código; no se reescribe.", "sys");
      } else {
        const cmd = protocolo.construirAsignacion(resp.codigo);
        await transporte.escribir(cmd);
        consola.log(cmd.trim(), "tx");
        tracker.push("tx", cmd.trim());
        logSistema(`Enviado al equipo: ${cmd.trim()}`, "ok");
        ui.mensajeAsignacion.textContent = `${resp.mensaje}. Escrito al dispositivo por serial.`;
      }
    }
  } catch (e) {
    ui.mensajeAsignacion.textContent = e.message;
    ui.mensajeAsignacion.dataset.kind = "err";
    logSistema(e.message, "err");
  } finally {
    ui.btnGenerar.disabled = false;
    ui.btnSoloGenerar.disabled = false;
  }
}

init().catch((e) => {
  console.error(e);
  setEstado(`Error init: ${e.message}`);
});
