from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Float,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class SerieCodigo(Base):
    __tablename__ = "series_codigos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    serie_origen: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    codigo: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    estado: Mapped[str] = mapped_column(String(20), default="activo", nullable=False)
    nota: Mapped[str | None] = mapped_column(Text, nullable=True)
    creado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    actualizado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    archivado_en: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    historial: Mapped[list["HistorialModificacion"]] = relationship(
        "HistorialModificacion",
        back_populates="serie",
        cascade="all, delete-orphan",
        order_by="HistorialModificacion.creado_en.desc()",
    )


class HistorialModificacion(Base):
    __tablename__ = "historial_modificaciones"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    serie_id: Mapped[int] = mapped_column(ForeignKey("series_codigos.id"), nullable=False, index=True)
    campo: Mapped[str] = mapped_column(String(64), nullable=False)
    valor_anterior: Mapped[str | None] = mapped_column(Text, nullable=True)
    valor_nuevo: Mapped[str | None] = mapped_column(Text, nullable=True)
    motivo: Mapped[str | None] = mapped_column(Text, nullable=True)
    creado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    serie: Mapped["SerieCodigo"] = relationship("SerieCodigo", back_populates="historial")


class Usuario(Base):
    __tablename__ = "usuarios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    nombre: Mapped[str] = mapped_column(String(120), nullable=False)
    rol: Mapped[str] = mapped_column(String(20), default="operador", nullable=False)  # superusuario|operador
    estado: Mapped[str] = mapped_column(String(20), default="activo", nullable=False)  # activo|archivado
    email: Mapped[str | None] = mapped_column(String(160), nullable=True)
    creado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    actualizado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    archivado_en: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    sesiones_auth: Mapped[list["SesionAuth"]] = relationship(
        "SesionAuth", back_populates="usuario", cascade="all, delete-orphan"
    )
    sesiones_serial: Mapped[list["SesionSerial"]] = relationship(
        "SesionSerial", back_populates="usuario", cascade="all, delete-orphan"
    )


class SesionAuth(Base):
    """Sesión de login (JWT jti) para control de acceso."""

    __tablename__ = "sesiones_auth"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    usuario_id: Mapped[int] = mapped_column(ForeignKey("usuarios.id"), nullable=False, index=True)
    jti: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    lugar: Mapped[str | None] = mapped_column(String(160), nullable=True)
    activa: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    inicio: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    fin: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ultimo_acceso: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    usuario: Mapped["Usuario"] = relationship("Usuario", back_populates="sesiones_auth")


class SesionSerial(Base):
    """Una sincronización serial (puede haber muchas por usuario/día)."""

    __tablename__ = "sesiones_serial"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    usuario_id: Mapped[int] = mapped_column(ForeignKey("usuarios.id"), nullable=False, index=True)
    sesion_auth_id: Mapped[int | None] = mapped_column(
        ForeignKey("sesiones_auth.id"), nullable=True, index=True
    )

    # Dispositivo sincronizado
    dispositivo_etiqueta: Mapped[str | None] = mapped_column(String(160), nullable=True)
    dispositivo_vid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    dispositivo_pid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    dispositivo_ruta: Mapped[str | None] = mapped_column(String(160), nullable=True)
    baudrate: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Contexto de conexión del usuario
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lugar: Mapped[str | None] = mapped_column(String(160), nullable=True)
    latitud: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitud: Mapped[float | None] = mapped_column(Float, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # Ventana de sincronización
    inicio_sync: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    fin_sync: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    estado: Mapped[str] = mapped_column(String(20), default="activa", nullable=False)  # activa|cerrada|error

    # Resumen
    bytes_rx: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    lineas_rx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    lineas_tx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    codigo_detectado: Mapped[str | None] = mapped_column(String(64), nullable=True)
    codigo_asignado: Mapped[str | None] = mapped_column(String(64), nullable=True)
    nota: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    usuario: Mapped["Usuario"] = relationship("Usuario", back_populates="sesiones_serial")
    eventos: Mapped[list["SesionSerialEvento"]] = relationship(
        "SesionSerialEvento",
        back_populates="sesion",
        cascade="all, delete-orphan",
        order_by="SesionSerialEvento.id",
    )


class SesionSerialEvento(Base):
    """Líneas / eventos de una sesión serial para análisis posterior."""

    __tablename__ = "sesiones_serial_eventos"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, index=True)
    sesion_id: Mapped[int] = mapped_column(ForeignKey("sesiones_serial.id"), nullable=False, index=True)
    tipo: Mapped[str] = mapped_column(String(16), default="rx", nullable=False)  # rx|tx|sys|warn|err
    contenido: Mapped[str] = mapped_column(Text, nullable=False)
    creado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    sesion: Mapped["SesionSerial"] = relationship("SesionSerial", back_populates="eventos")
