import glob
import os
import sys

from serial.tools import list_ports

RUIDO = ("Bluetooth-Incoming-Port", "debug-console", "wlan-debug")


def _estable(p) -> str:
    if sys.platform.startswith("linux"):
        for enlace in glob.glob("/dev/serial/by-id/*"):
            try:
                if os.path.realpath(enlace) == p.device:
                    return enlace
            except OSError:
                continue
    return p.device


def listar_puertos() -> list[dict]:
    salida = []
    for p in list_ports.comports():
        if sys.platform == "darwin":
            if not p.device.startswith("/dev/cu."):
                continue
            if any(r in p.device for r in RUIDO):
                continue
        if sys.platform.startswith("linux") and p.device.startswith("/dev/ttyS"):
            if not p.vid:
                continue

        ruta = p.device
        if sys.platform.startswith("win") and ruta.upper().startswith("COM"):
            try:
                n = int(ruta[3:])
                if n >= 10:
                    ruta = f"\\\\.\\{ruta}"
            except ValueError:
                pass

        salida.append(
            {
                "ruta": ruta,
                "estable": _estable(p),
                "descripcion": p.description,
                "fabricante": p.manufacturer,
                "vid": p.vid,
                "pid": p.pid,
                "serie": p.serial_number,
                "ubicacion": p.location,
                "etiqueta": p.description or ruta,
            }
        )
    return salida
