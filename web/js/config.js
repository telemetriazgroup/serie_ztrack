/** Prefijo global de la aplicación en el servidor. */
export const API_BASE = "/monitor";
export const WEB_BASE = "/monitor/serial";

export function apiUrl(path = "") {
  if (!path) return API_BASE;
  return path.startsWith("/") ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
}

export function webUrl(path = "") {
  if (!path) return `${WEB_BASE}/`;
  return path.startsWith("/") ? `${WEB_BASE}${path}` : `${WEB_BASE}/${path}`;
}
