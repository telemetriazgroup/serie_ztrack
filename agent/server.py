"""
Agente local ZTrack Serial.
Escucha SOLO en 127.0.0.1:8765 — nunca exposible a la red.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import threading
import time
from typing import Any

import serial
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from agent.ports import listar_puertos

HOST = "127.0.0.1"
PORT = int(os.getenv("ZTRACK_AGENT_PORT", "8765"))
TOKEN = os.getenv("ZTRACK_AGENT_TOKEN", "ztrack-local")
ORIGINS = {
    o.strip()
    for o in os.getenv(
        "ZTRACK_AGENT_ORIGINS",
        "http://localhost:9490,http://127.0.0.1:9490,https://localhost:9490,"
        "http://localhost:9490/monitor,http://127.0.0.1:9490/monitor",
    ).split(",")
    if o.strip()
}

app = FastAPI(title="ZTrack Serial Agent", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ORIGINS) + ["null"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SerialSession:
    def __init__(self) -> None:
        self.ser: serial.Serial | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.queue: asyncio.Queue | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    @property
    def abierto(self) -> bool:
        return bool(self.ser and self.ser.is_open)

    def abrir(self, ruta: str, baudrate: int = 115200, exclusive: bool = True) -> None:
        self.cerrar()
        ser = serial.Serial()
        ser.port = ruta
        ser.baudrate = baudrate
        ser.timeout = 0.05
        ser.exclusive = exclusive
        ser.dsrdtr = False
        ser.rtscts = False
        ser.open()
        self.ser = ser
        self._stop.clear()
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()

    def _reader(self) -> None:
        while not self._stop.is_set() and self.ser and self.ser.is_open:
            try:
                n = self.ser.in_waiting
                data = self.ser.read(max(1, n))
                if data and self.queue is not None and self.loop is not None:
                    b64 = base64.b64encode(data).decode("ascii")
                    self.loop.call_soon_threadsafe(
                        self.queue.put_nowait, {"evt": "datos", "b64": b64}
                    )
            except serial.SerialException as e:
                if self.queue is not None and self.loop is not None:
                    self.loop.call_soon_threadsafe(
                        self.queue.put_nowait,
                        {"evt": "error", "mensaje": f"SerialException: {e}"},
                    )
                break
            except Exception:
                time.sleep(0.05)

    def escribir(self, raw: bytes) -> None:
        if not self.ser or not self.ser.is_open:
            raise RuntimeError("Puerto no abierto")
        if len(raw) > 4096:
            raise RuntimeError("Trama demasiado grande")
        self.ser.write(raw)

    def senales(self, dtr: bool | None = None, rts: bool | None = None) -> None:
        if not self.ser or not self.ser.is_open:
            return
        if dtr is not None:
            self.ser.dtr = dtr
        if rts is not None:
            self.ser.rts = rts

    def cerrar(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self._thread = None
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
        self.ser = None


session = SerialSession()


def _check_token(token: str | None) -> None:
    if token != TOKEN:
        raise HTTPException(status_code=401, detail="Token inválido")


@app.get("/salud")
def salud():
    return {
        "ok": True,
        "servicio": "ztrack-serial-agent",
        "puerto": PORT,
        "serial_abierto": session.abierto,
    }


@app.get("/puertos")
def puertos(x_agent_token: str | None = Header(default=None)):
    _check_token(x_agent_token)
    return listar_puertos()


@app.websocket("/ws")
async def ws_serial(websocket: WebSocket, token: str = Query(default="")):
    origin = websocket.headers.get("origin")
    if origin and ORIGINS and origin not in ORIGINS and not origin.startswith("http://127.0.0.1"):
        # permitir file:// (null) y localhost variantes usadas en pruebas
        if origin not in ("null",) and "localhost" not in origin and "127.0.0.1" not in origin:
            await websocket.close(code=1008)
            return

    if token != TOKEN:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    session.loop = asyncio.get_running_loop()
    session.queue = asyncio.Queue()

    async def bombea_cola():
        while True:
            msg = await session.queue.get()
            await websocket.send_text(json.dumps(msg))

    pump = asyncio.create_task(bombea_cola())
    poll = asyncio.create_task(_poll_puertos(websocket))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg: dict[str, Any] = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"evt": "error", "mensaje": "JSON inválido"}))
                continue
            await _manejar_cmd(websocket, msg)
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        poll.cancel()
        session.cerrar()


async def _poll_puertos(websocket: WebSocket):
    prev = {p["ruta"] for p in listar_puertos()}
    while True:
        await asyncio.sleep(1.5)
        actual_list = listar_puertos()
        actual = {p["ruta"] for p in actual_list}
        alta = [p for p in actual_list if p["ruta"] not in prev]
        baja = sorted(prev - actual)
        if alta or baja:
            await websocket.send_text(
                json.dumps({"evt": "puertos", "alta": alta, "baja": baja})
            )
        prev = actual


async def _manejar_cmd(websocket: WebSocket, msg: dict[str, Any]):
    cmd = msg.get("cmd")
    try:
        if cmd == "abrir":
            ruta = msg["ruta"]
            baud = int(msg.get("baudrate", 115200))
            session.abrir(ruta, baudrate=baud, exclusive=bool(msg.get("exclusive", True)))
            await websocket.send_text(
                json.dumps({"evt": "estado", "tipo": "conectado", "ruta": ruta})
            )
        elif cmd == "escribir":
            data = base64.b64decode(msg["b64"])
            session.escribir(data)
        elif cmd == "senales":
            session.senales(
                dtr=msg.get("dataTerminalReady"),
                rts=msg.get("requestToSend"),
            )
        elif cmd == "cerrar":
            session.cerrar()
            await websocket.send_text(json.dumps({"evt": "estado", "tipo": "cerrado"}))
        elif cmd == "listar":
            await websocket.send_text(json.dumps({"evt": "puertos", "lista": listar_puertos()}))
        else:
            await websocket.send_text(
                json.dumps({"evt": "error", "mensaje": f"Comando desconocido: {cmd}"})
            )
    except Exception as e:
        await websocket.send_text(json.dumps({"evt": "error", "mensaje": str(e)}))


def main():
    print(f"ZTrack Serial Agent → http://{HOST}:{PORT} (solo localhost)")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
