/**
 * Bases públicas según cómo se accede a la app.
 *
 * 1) Directo al contenedor:
 *    https://IP:9490/monitor/serial/...
 *    API_BASE=/monitor  WEB_BASE=/monitor/serial
 *
 * 2) Proxy dual (recomendado en ztrack.app):
 *    ProxyPass /serial/  → .../monitor/serial/
 *    ProxyPass /monitor/ → .../monitor/
 *    UI:  https://ztrack.app/serial/login.html
 *    API: https://ztrack.app/monitor/auth/...
 *
 * 3) Proxy único (el que configuraste):
 *    ProxyPass /serial/ → .../monitor/
 *    UI:  https://ztrack.app/serial/serial/login.html
 *    API: https://ztrack.app/serial/auth/...
 */
function resolveBases() {
  const p = location.pathname || "";

  // Acceso directo al contenedor / puerto 9490
  if (p.startsWith("/monitor/serial")) {
    return { API_BASE: "/monitor", WEB_BASE: "/monitor/serial", modo: "directo" };
  }

  // Proxy dual: UI en /serial/* (sin /serial/serial)
  if (p.startsWith("/serial/") && !p.startsWith("/serial/serial")) {
    return { API_BASE: "/monitor", WEB_BASE: "/serial", modo: "proxy-dual" };
  }
  if (p === "/serial" || p === "/serial/") {
    return { API_BASE: "/monitor", WEB_BASE: "/serial", modo: "proxy-dual" };
  }

  // Proxy único: /serial/ → /monitor/  ⇒ la UI queda en /serial/serial/*
  if (p.startsWith("/serial/serial")) {
    return { API_BASE: "/serial", WEB_BASE: "/serial/serial", modo: "proxy-unico" };
  }

  // Fallback seguro (desarrollo local)
  return { API_BASE: "/monitor", WEB_BASE: "/monitor/serial", modo: "directo" };
}

const bases = resolveBases();

export const API_BASE = bases.API_BASE;
export const WEB_BASE = bases.WEB_BASE;
export const PROXY_MODO = bases.modo;

export function apiUrl(path = "") {
  if (!path) return API_BASE;
  return path.startsWith("/") ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
}

export function webUrl(path = "") {
  if (!path || path === "/") return `${WEB_BASE}/`;
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${WEB_BASE}${clean}`;
}
