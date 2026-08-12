from datetime import datetime

from pydantic import BaseModel, Field


class HistorialOut(BaseModel):
    id: int
    campo: str
    valor_anterior: str | None
    valor_nuevo: str | None
    motivo: str | None
    creado_en: datetime

    model_config = {"from_attributes": True}


class SerieOut(BaseModel):
    id: int
    serie_origen: str
    codigo: str
    estado: str
    nota: str | None
    creado_en: datetime
    actualizado_en: datetime
    archivado_en: datetime | None
    historial: list[HistorialOut] = []

    model_config = {"from_attributes": True}


class GenerarResponse(BaseModel):
    mensaje: str
    ya_asignado: bool
    serie_origen: str
    codigo: str
    estado: str
    creado_en: datetime


class ModificarRequest(BaseModel):
    nota: str | None = Field(default=None, description="Nota o descripción asociada al código")
    motivo: str | None = Field(default=None, description="Motivo de la modificación")


class ArchivarRequest(BaseModel):
    motivo: str | None = Field(default=None, description="Motivo del archivado")


class EstadisticasOut(BaseModel):
    hoy: int
    esta_semana: int
    este_mes: int
    este_anio: int
    total_activos: int
    total_archivados: int
    total: int
