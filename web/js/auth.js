import { API_BASE, WEB_BASE, PROXY_MODO, apiUrl, webUrl } from "./config.js";

const TOKEN_KEY = "ztrack_token";
const USER_KEY = "ztrack_user";
const LUGAR_KEY = "ztrack_lugar";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function getLugar() {
  return localStorage.getItem(LUGAR_KEY) || "";
}

export function setLugar(lugar) {
  if (lugar) localStorage.setItem(LUGAR_KEY, lugar);
}

export function isSuperusuario() {
  const u = getUser();
  return u?.rol === "superusuario";
}

export function saveAuth(token, usuario) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(usuario));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const url = path.startsWith("http") ? path : apiUrl(path);
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearAuth();
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `${webUrl("/login.html")}?next=${next}`;
    throw new Error("No autenticado");
  }
  return res;
}

export async function requireAuth({ superOnly = false } = {}) {
  const token = getToken();
  if (!token) {
    location.href = `${webUrl("/login.html")}?next=${encodeURIComponent(location.pathname)}`;
    return null;
  }
  const res = await apiFetch("/auth/me");
  if (!res.ok) {
    clearAuth();
    location.href = webUrl("/login.html");
    return null;
  }
  const user = await res.json();
  saveAuth(token, user);
  if (superOnly && user.rol !== "superusuario") {
    location.href = webUrl("/");
    return null;
  }
  return user;
}

export async function login(username, password, lugar) {
  const body = { username, password, lugar: lugar || null };
  try {
    const pos = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject();
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 2500 });
    });
    body.latitud = pos.coords.latitude;
    body.longitud = pos.coords.longitude;
  } catch (_) {}

  const res = await fetch(apiUrl("/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Login fallido");
  saveAuth(data.access_token, data.usuario);
  if (lugar) setLugar(lugar);
  return data;
}

export async function logout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch (_) {}
  clearAuth();
  location.href = webUrl("/login.html");
}

export async function obtenerGeoLugar() {
  const lugarGuardado = getLugar();
  let latitud = null;
  let longitud = null;
  try {
    const pos = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject();
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 2500 });
    });
    latitud = pos.coords.latitude;
    longitud = pos.coords.longitude;
  } catch (_) {}
  return { lugar: lugarGuardado || null, latitud, longitud };
}

export { API_BASE, WEB_BASE, PROXY_MODO, apiUrl, webUrl };
