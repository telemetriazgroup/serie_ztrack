from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.database import Base, SessionLocal, engine
from app.routes import router as serie_router
from app.routes_auth import router as auth_router
from app.routes_sesiones import router as sesiones_router
from app.routes_usuarios import router as usuarios_router
from app.seed import ensure_superusuario

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MONITOR_PREFIX = "/monitor"


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        ensure_superusuario(db)
    finally:
        db.close()
    yield


app = FastAPI(
    title="ZTrack Serie API",
    description="API códigos ZG + Serial Web + Usuarios/Sesiones bajo /monitor",
    version="1.3.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API bajo /monitor/...
app.include_router(auth_router, prefix=MONITOR_PREFIX)
app.include_router(usuarios_router, prefix=MONITOR_PREFIX)
app.include_router(sesiones_router, prefix=MONITOR_PREFIX)
app.include_router(serie_router, prefix=MONITOR_PREFIX)


@app.get("/health")
@app.get(f"{MONITOR_PREFIX}/health")
def health():
    return {"status": "ok", "base": MONITOR_PREFIX}


@app.get("/")
def root():
    return RedirectResponse(url=f"{MONITOR_PREFIX}/serial/login.html")


@app.get(MONITOR_PREFIX)
@app.get(f"{MONITOR_PREFIX}/")
def monitor_root():
    return RedirectResponse(url=f"{MONITOR_PREFIX}/serial/login.html")


# Compatibilidad: rutas antiguas /serial → /monitor/serial
@app.get("/serial")
@app.get("/serial/")
def legacy_serial_root():
    return RedirectResponse(url=f"{MONITOR_PREFIX}/serial/")


@app.get("/serial/{path:path}")
def legacy_serial_redirect(path: str):
    return RedirectResponse(url=f"{MONITOR_PREFIX}/serial/{path}")


if WEB_DIR.is_dir():
    app.mount(
        f"{MONITOR_PREFIX}/serial",
        StaticFiles(directory=str(WEB_DIR), html=True),
        name="serial",
    )
