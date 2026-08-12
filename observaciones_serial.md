# Observaciones validadas — Monitor Serial Web (CH340)

Fuente: panel Diagnóstico · equipo WCH CH340 (VID `6790` / PID `29987`) · 115200 baud · Web Serial.

---

## OBS-01 — Falso `stream-done` por reenganche (CRÍTICA · confirmada)

**Evidencia (log):**
```
silencio → reenganche {"motivo":"manual"}
→ stream-done
→ reapertura {"motivo":"stream-done"}
→ error-stream TypeError "Releasing Default reader"
→ gen 20 → 22 → 24 → 26 (bucle de reaperturas)
```

**Causa:** `reader.cancel()` (reenganche ante silencio) hace que el `read()` pendiente resuelva `{ done: true }`. El código trataba ese `done` como muerte real del stream y ejecutaba `close()+open()`, peores que el silencio original.

**Efecto:** la UI entra en ciclo de reapertura, pierde RX durante el churn y parece “colapsada”.

**Estado:** corregido — `done` por cancel intencional solo cambia de reader; no reabre puerto.

---

## OBS-02 — `TypeError: Releasing Default reader` (confirmada · no fatal)

**Evidencia:** aparece siempre junto al reenganche/cancel.

**Causa:** al `cancel()` el reader, el `read()` pendiente rechaza o el `releaseLock()` del `finally` corre sobre un reader ya liberado.

**Efecto:** se contabilizaba como `error-stream` y disparaba otra recuperación agresiva.

**Estado:** corregido — se ignora como error esperado de cancelación.

---

## OBS-03 — Silencio RX ~16 s antes de la primera intervención

**Evidencia:** `silencio {"ms":16000}` previo al primer reenganche.

**Hipótesis abiertas (no cerradas aún):**
1. El firmware deja de emitir un tramo (SIM/UART3) — en Arduino IDE a veces hay pausas similares.
2. El stream Web Serial del CH340 se queda sin empujar chunks sin cerrar (menos frecuente).
3. La UI dejó de drenar y el driver pausó (menos probable tras el render por lotes).

**Acción:** con OBS-01/02 corregidas, medir de nuevo. Si el silencio sigue sin `stream-done` ni `getReaderFail`, el origen es el equipo/firmware o el driver, no la recuperación.

---

## OBS-04 — Basura inicial `����UART1:` (menor · esperada)

Bytes no ASCII al abrir el puerto. Típico de:
- flanco DTR/RTS al `open()`
- basura de sincronización UART

**No explica** el corte a los 16 s. Se mitiga con `setSignals({ DTR:false, RTS:false })` post-open.

---

## OBS-05 — Recuperación demasiado agresiva (confirmada)

Watchdog a 12 s (reenganche) + 20 s (reopen) + interpretar `done` como reopen = tormentas de `gen++`.

**Estado:** suavizado — reenganche suave una vez; reopen solo si el stream queda inválido o el silencio persiste tras el suave.

---

## Cómo revalidar en planta

1. Hard refresh (`Ctrl+Shift+R`) en `/serial/`.
2. Conectar CH340, dejar 2–3 minutos.
3. En Diagnóstico, lo **esperado** ahora:
   - `reaperturas` ≈ 0 en sesión estable
   - `doneStream` no debe subir por cada reenganche
   - `getReaderFail` ≈ 0
   - Si hay silencio real: como mucho 1 `reenganche` suave, sin tormenta de `gen`
4. Exportar JSON si el silencio vuelve **sin** eventos `stream-done`/`getReader-fail`.

---

## Resumen ejecutivo

| ID | Severidad | Validada | Acción |
|----|-----------|----------|--------|
| OBS-01 | Crítica | Sí | No reabrir por `done` de cancel |
| OBS-02 | Media | Sí | Ignorar TypeError de release |
| OBS-03 | Media | Parcial | Re-medir tras fix |
| OBS-04 | Baja | Sí | Cosmética / DTR |
| OBS-05 | Alta | Sí | Watchdog menos agresivo |
