from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
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
