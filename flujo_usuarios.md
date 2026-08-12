# Usuarios, acceso y sesiones serial

## Credenciales iniciales

| Usuario | Password | Rol |
|---------|----------|-----|
| `ztrack` | `proyectoztrack2023` | superusuario |

Se crea automáticamente al arrancar la API.

---

## Roles

| Rol | Puede |
|-----|--------|
| **superusuario** | CRUD usuarios, ver debug serial, ver todas las sesiones, debug resumen |
| **operador** | Usar serial, generar códigos, ver **sus** sesiones |

---

## Flujo

1. Login en `/monitor/serial/login.html` (usuario + lugar/sede; geo opcional del navegador).
2. Se crea `sesiones_auth` (JWT + IP + user-agent + lugar).
3. Al **Conectar** un puerto en Serial Web → `sesiones_serial` (inicio_sync, dispositivo, IP, lugar).
4. Mientras hay RX/TX se hace append periódico de líneas.
5. Al desconectar / logout / cerrar pestaña → `fin_sync` y estado `cerrada`.
6. Historial y análisis en `/monitor/serial/sesiones.html`.

Un usuario puede tener **muchas sesiones serial por día**.

---

## API principal

| Método | Ruta | Notas |
|--------|------|-------|
| POST | `/monitor/auth/login` | Devuelve JWT |
| POST | `/monitor/auth/logout` | Invalida sesión auth |
| GET | `/monitor/auth/me` | Usuario actual |
| GET/POST | `/monitor/usuarios` | Solo superusuario |
| PUT | `/monitor/usuarios/{id}` | Editar |
| PUT | `/monitor/usuarios/{id}/archivar` | Archivar |
| POST | `/monitor/sesiones-serial/iniciar` | Inicio sync |
| POST | `/monitor/sesiones-serial/{id}/append` | Eventos RX/TX |
| POST | `/monitor/sesiones-serial/{id}/cerrar` | Fin sync |
| GET | `/monitor/sesiones-serial` | Listado |
| GET | `/monitor/sesiones-serial/{id}` | Detalle + log |
| GET | `/monitor/sesiones-serial/debug/resumen` | Solo superusuario |

Todas las rutas `/monitor/serie/*` requieren Bearer token.

---

## UI

- `/monitor/serial/login.html` — acceso
- `/monitor/serial/` — monitor (debug solo superusuario)
- `/monitor/serial/usuarios.html` — administración (superusuario)
- `/monitor/serial/sesiones.html` — historial y análisis
