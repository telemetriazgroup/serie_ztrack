import { apiFetch, isSuperusuario, logout, requireAuth } from "./auth.js";

const $ = (s) => document.querySelector(s);

function fmt(dt) {
  if (!dt) return "—";
  try {
    return new Date(dt).toLocaleString("es-PE");
  } catch {
    return dt;
  }
}

async function cargarLista() {
  const res = await apiFetch("/sesiones-serial?limit=100");
  const rows = await res.json();
  const tb = $("#tabla-sesiones tbody");
  tb.innerHTML = "";
  for (const s of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.id}</td>
      <td>${s.usuario_username || s.usuario_id}</td>
      <td>${s.dispositivo_etiqueta || "—"}</td>
      <td><code>${s.ip || "—"}</code></td>
      <td>${s.lugar || "—"}</td>
      <td>${fmt(s.inicio_sync)}</td>
      <td>${fmt(s.fin_sync)}</td>
      <td>${s.lineas_rx} L / ${s.bytes_rx} B</td>
      <td><span class="badge" data-estado="${s.estado}">${s.estado}</span></td>
      <td></td>`;
    const btn = document.createElement("button");
    btn.className = "btn tiny";
    btn.textContent = "Ver";
    btn.onclick = () => verDetalle(s.id);
    tr.lastElementChild.appendChild(btn);
    tb.appendChild(tr);
  }
}

async function verDetalle(id) {
  const res = await apiFetch(`/sesiones-serial/${id}?limit_eventos=8000`);
  if (!res.ok) {
    alert("No se pudo cargar la sesión");
    return;
  }
  const s = await res.json();
  $("#detalle-panel").hidden = false;
  $("#det-id").textContent = s.id;
  $("#det-meta").textContent = [
    `usuario: ${s.usuario_username} (${s.usuario_nombre || ""})`,
    `dispositivo: ${s.dispositivo_etiqueta} vid=${s.dispositivo_vid} pid=${s.dispositivo_pid}`,
    `baud: ${s.baudrate}`,
    `ip: ${s.ip}`,
    `lugar: ${s.lugar}`,
    `geo: ${s.latitud ?? "—"}, ${s.longitud ?? "—"}`,
    `inicio: ${fmt(s.inicio_sync)}`,
    `fin: ${fmt(s.fin_sync)}`,
    `estado: ${s.estado}`,
    `RX: ${s.lineas_rx} líneas / ${s.bytes_rx} bytes · TX: ${s.lineas_tx}`,
    `codigo_detectado: ${s.codigo_detectado || "—"}`,
    `codigo_asignado: ${s.codigo_asignado || "—"}`,
    `nota: ${s.nota || "—"}`,
  ].join("\n");

  const log = $("#det-log");
  log.textContent = (s.eventos || [])
    .map((e) => {
      const t = e.creado_en?.slice(11, 19) || "";
      const p =
        e.tipo === "tx" ? "›" : e.tipo === "sys" ? "·" : e.tipo === "warn" ? "!" : e.tipo === "err" ? "×" : " ";
      return `${t} ${p} ${e.contenido}`;
    })
    .join("\n");
  log.scrollTop = 0;
}

async function cargarDebug() {
  if (!isSuperusuario()) return;
  const box = $("#debug-box");
  box.hidden = false;
  try {
    const res = await apiFetch("/sesiones-serial/debug/resumen");
    const d = await res.json();
    box.textContent =
      `DEBUG superusuario · usuarios ${d.usuarios_activos}/${d.usuarios_total} · ` +
      `sesiones hoy ${d.sesiones_serial_hoy} · activas ${d.sesiones_serial_activas}`;
  } catch (_) {
    box.textContent = "DEBUG no disponible";
  }
}

$("#btn-refresh")?.addEventListener("click", () => cargarLista());
$("#btn-cerrar-det")?.addEventListener("click", () => {
  $("#detalle-panel").hidden = true;
});
$("#btn-logout")?.addEventListener("click", () => logout());

const user = await requireAuth();
if (user) {
  $("#user-pill").textContent = `${user.username} · ${user.rol}`;
  if (user.rol === "superusuario") {
    $("#nav-users").hidden = false;
  }
  await cargarLista();
  await cargarDebug();
}
