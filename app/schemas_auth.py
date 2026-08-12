from datetime import datetime

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str
    password: str
    lugar: str | None = Field(default=None, description="Lugar reportado por el cliente")
    latitud: float | None = None
    longitud: float | None = None


class UsuarioOut(BaseModel):
    id: int
    username: str
    nombre: str
    rol: str
    estado: str
    email: str | None
    creado_en: datetime
    actualizado_en: datetime
    archivado_en: datetime | None = None

    model_config = {"from_attributes": True}


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    usuario: UsuarioOut
    sesion_auth_id: int
    ip: str | None = None
    lugar: str | None = None


class UsuarioCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=128)
    nombre: str = Field(min_length=2, max_length=120)
    rol: str = Field(default="operador", pattern="^(superusuario|operador)$")
    email: str | None = None


class UsuarioUpdate(BaseModel):
    nombre: str | None = None
    email: str | None = None
    rol: str | None = Field(default=None, pattern="^(superusuario|operador)$")
    password: str | None = Field(default=None, min_length=6, max_length=128)


class ArchivarUsuarioRequest(BaseModel):
    motivo: str | None = None


class SesionAuthOut(BaseModel):
    id: int
    usuario_id: int
    ip: str | None
    lugar: str | None
    user_agent: str | None
    activa: bool
    inicio: datetime
    fin: datetime | None
    ultimo_acceso: datetime

    model_config = {"from_attributes": True}


class SesionSerialIniciar(BaseModel):
    dispositivo_etiqueta: str | None = None
    dispositivo_vid: int | None = None
    dispositivo_pid: int | None = None
    dispositivo_ruta: str | None = None
    baudrate: int | None = 115200
    lugar: str | None = None
    latitud: float | None = None
    longitud: float | None = None
    nota: str | None = None


class SesionSerialEventoIn(BaseModel):
    tipo: str = Field(default="rx", pattern="^(rx|tx|sys|warn|err)$")
    contenido: str
    ts: datetime | None = None


class SesionSerialAppend(BaseModel):
    eventos: list[SesionSerialEventoIn]
    codigo_detectado: str | None = None
    codigo_asignado: str | None = None


class SesionSerialCerrar(BaseModel):
    nota: str | None = None
    codigo_detectado: str | None = None
    codigo_asignado: str | None = None


class SesionSerialEventoOut(BaseModel):
    id: int
    tipo: str
    contenido: str
    creado_en: datetime

    model_config = {"from_attributes": True}


class SesionSerialOut(BaseModel):
    id: int
    usuario_id: int
    dispositivo_etiqueta: str | None
    dispositivo_vid: int | None
    dispositivo_pid: int | None
    dispositivo_ruta: str | None
    baudrate: int | None
    ip: str | None
    lugar: str | None
    latitud: float | None
    longitud: float | None
    inicio_sync: datetime
    fin_sync: datetime | None
    estado: str
    bytes_rx: int
    lineas_rx: int
    lineas_tx: int
    codigo_detectado: str | None
    codigo_asignado: str | None
    nota: str | None
    usuario_username: str | None = None
    usuario_nombre: str | None = None

    model_config = {"from_attributes": True}


class SesionSerialDetalle(SesionSerialOut):
    eventos: list[SesionSerialEventoOut] = []
