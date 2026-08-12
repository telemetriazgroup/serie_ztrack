from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.config import settings
from app.models import HistorialModificacion, SerieCodigo


def now_local() -> datetime:
    return datetime.now(ZoneInfo(settings.timezone))


def build_codigo_base(moment: datetime) -> str:
    """ZG + YYMMDDHHMMSS (sin correlativo)."""
    return (
        f"ZG"
        f"{moment.year % 100:02d}"
        f"{moment.month:02d}"
        f"{moment.day:02d}"
        f"{moment.hour:02d}"
        f"{moment.minute:02d}"
        f"{moment.second:02d}"
    )


def next_correlativo(db: Session, codigo_base: str) -> int:
    """Obtiene el siguiente correlativo (0, 1, 2...) para el mismo segundo."""
    existentes = db.scalars(
        select(SerieCodigo.codigo).where(SerieCodigo.codigo.like(f"{codigo_base}%"))
    ).all()

    usados: set[int] = set()
    for codigo in existentes:
        sufijo = codigo[len(codigo_base) :]
        if sufijo.isdigit():
            usados.add(int(sufijo))

    correlativo = 0
    while correlativo in usados:
        correlativo += 1
    return correlativo


def generar_codigo(db: Session) -> str:
    moment = now_local()
    base = build_codigo_base(moment)
    correlativo = next_correlativo(db, base)
    return f"{base}{correlativo}"


def get_by_serie_or_codigo(db: Session, valor: str) -> SerieCodigo | None:
    return db.scalars(
        select(SerieCodigo)
        .options(joinedload(SerieCodigo.historial))
        .where(
            (SerieCodigo.serie_origen == valor) | (SerieCodigo.codigo == valor)
        )
    ).first()


def generar_o_recuperar(db: Session, serie: str) -> tuple[SerieCodigo, bool]:
    """
    Si la serie/código ya existe, lo recupera.
    Si no existe, genera un código nuevo y lo asigna a serie_origen.
    Retorna (registro, ya_asignado).
    """
    existente = get_by_serie_or_codigo(db, serie)
    if existente:
        return existente, True

    codigo = generar_codigo(db)
    registro = SerieCodigo(
        serie_origen=serie,
        codigo=codigo,
        estado="activo",
    )
    db.add(registro)
    db.commit()
    db.refresh(registro)
    return registro, False


def modificar_serie(
    db: Session,
    codigo: str,
    nota: str | None,
    motivo: str | None,
) -> SerieCodigo | None:
    registro = db.scalars(
        select(SerieCodigo)
        .options(joinedload(SerieCodigo.historial))
        .where(SerieCodigo.codigo == codigo)
    ).first()
    if not registro:
        return None

    if nota is not None and nota != registro.nota:
        db.add(
            HistorialModificacion(
                serie_id=registro.id,
                campo="nota",
                valor_anterior=registro.nota,
                valor_nuevo=nota,
                motivo=motivo,
            )
        )
        registro.nota = nota

    db.commit()
    db.refresh(registro)
    return registro


def archivar_serie(db: Session, codigo: str, motivo: str | None) -> SerieCodigo | None:
    registro = db.scalars(
        select(SerieCodigo)
        .options(joinedload(SerieCodigo.historial))
        .where(SerieCodigo.codigo == codigo)
    ).first()
    if not registro:
        return None

    if registro.estado != "archivado":
        db.add(
            HistorialModificacion(
                serie_id=registro.id,
                campo="estado",
                valor_anterior=registro.estado,
                valor_nuevo="archivado",
                motivo=motivo,
            )
        )
        registro.estado = "archivado"
        registro.archivado_en = datetime.now(timezone.utc)
        db.commit()
        db.refresh(registro)

    return registro


def ultimo_codigo(db: Session) -> SerieCodigo | None:
    return db.scalars(
        select(SerieCodigo)
        .options(joinedload(SerieCodigo.historial))
        .order_by(SerieCodigo.creado_en.desc())
        .limit(1)
    ).first()


def ultimos_codigos(db: Session, limit: int = 10) -> list[SerieCodigo]:
    return list(
        db.scalars(
            select(SerieCodigo)
            .options(joinedload(SerieCodigo.historial))
            .order_by(SerieCodigo.creado_en.desc())
            .limit(limit)
        ).unique().all()
    )


def todos_codigos(db: Session) -> list[SerieCodigo]:
    return list(
        db.scalars(
            select(SerieCodigo)
            .options(joinedload(SerieCodigo.historial))
            .order_by(SerieCodigo.creado_en.desc())
        ).unique().all()
    )


def estadisticas(db: Session) -> dict:
    ahora = now_local()
    inicio_hoy = ahora.replace(hour=0, minute=0, second=0, microsecond=0)
    inicio_semana = inicio_hoy - timedelta(days=inicio_hoy.weekday())
    inicio_mes = inicio_hoy.replace(day=1)
    inicio_anio = inicio_hoy.replace(month=1, day=1)

    def contar_desde(inicio: datetime) -> int:
        return db.scalar(
            select(func.count())
            .select_from(SerieCodigo)
            .where(SerieCodigo.creado_en >= inicio.astimezone(timezone.utc))
        ) or 0

    total = db.scalar(select(func.count()).select_from(SerieCodigo)) or 0
    activos = (
        db.scalar(
            select(func.count())
            .select_from(SerieCodigo)
            .where(SerieCodigo.estado == "activo")
        )
        or 0
    )
    archivados = (
        db.scalar(
            select(func.count())
            .select_from(SerieCodigo)
            .where(SerieCodigo.estado == "archivado")
        )
        or 0
    )

    return {
        "hoy": contar_desde(inicio_hoy),
        "esta_semana": contar_desde(inicio_semana),
        "este_mes": contar_desde(inicio_mes),
        "este_anio": contar_desde(inicio_anio),
        "total_activos": activos,
        "total_archivados": archivados,
        "total": total,
    }
