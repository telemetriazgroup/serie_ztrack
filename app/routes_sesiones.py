from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.auth import ROL_SUPER, client_ip, get_current_user, require_superusuario
from app.database import get_db
from app.models import SesionSerial, SesionSerialEvento, Usuario
from app.schemas_auth import (
    SesionSerialAppend,
    SesionSerialCerrar,
    SesionSerialDetalle,
    SesionSerialIniciar,
    SesionSerialOut,
)

router = APIRouter(prefix="/sesiones-serial", tags=["sesiones-serial"])

MAX_EVENTOS_POR_APPEND = 500
MAX_EVENTOS_DETALLE = 20000


def _to_out(s: SesionSerial) -> SesionSerialOut:
    data = SesionSerialOut.model_validate(s)
    if s.usuario:
        data.usuario_username = s.usuario.username
        data.usuario_nombre = s.usuario.nombre
    return data


@router.post("/iniciar", response_model=SesionSerialOut, status_code=status.HTTP_201_CREATED)
def iniciar_sesion_serial(
    body: SesionSerialIniciar,
    request: Request,
    usuario: Annotated[Usuario, Depends(get_current_user)],
    db: Session = Depends(get_db),
):
    sesion_auth_id = getattr(request.state, "sesion_auth_id", None)
    sesion = SesionSerial(
        usuario_id=usuario.id,
        sesion_auth_id=sesion_auth_id,
        dispositivo_etiqueta=body.dispositivo_etiqueta,
        dispositivo_vid=body.dispositivo_vid,
        dispositivo_pid=body.dispositivo_pid,
        dispositivo_ruta=body.dispositivo_ruta,
        baudrate=body.baudrate,
        ip=client_ip(request),
        lugar=body.lugar,
        latitud=body.latitud,
        longitud=body.longitud,
        user_agent=request.headers.get("user-agent"),
        estado="activa",
        nota=body.nota,
    )
    db.add(sesion)
    db.commit()
    db.refresh(sesion)
    sesion.usuario = usuario
    return _to_out(sesion)


@router.post("/{sesion_id}/append", response_model=SesionSerialOut)
def append_eventos(
    sesion_id: int,
    body: SesionSerialAppend,
    usuario: Annotated[Usuario, Depends(get_current_user)],
    db: Session = Depends(get_db),
):
    sesion = db.scalars(
        select(SesionSerial)
        .options(joinedload(SesionSerial.usuario))
        .where(SesionSerial.id == sesion_id)
    ).first()
    if not sesion:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    if sesion.usuario_id != usuario.id and usuario.rol != ROL_SUPER:
        raise HTTPException(status_code=403, detail="Sin permiso")
    if sesion.estado != "activa":
        raise HTTPException(status_code=400, detail="Sesión ya cerrada")

    eventos = body.eventos[:MAX_EVENTOS_POR_APPEND]
    for ev in eventos:
        db.add(
            SesionSerialEvento(
                sesion_id=sesion.id,
                tipo=ev.tipo,
                contenido=ev.contenido[:8000],
                creado_en=ev.ts or datetime.now(timezone.utc),
            )
        )
        if ev.tipo == "rx":
            sesion.lineas_rx += 1
            sesion.bytes_rx += len(ev.contenido.encode("utf-8", errors="ignore"))
        elif ev.tipo == "tx":
            sesion.lineas_tx += 1

    if body.codigo_detectado:
        sesion.codigo_detectado = body.codigo_detectado
    if body.codigo_asignado:
        sesion.codigo_asignado = body.codigo_asignado

    db.commit()
    db.refresh(sesion)
    return _to_out(sesion)


@router.post("/{sesion_id}/cerrar", response_model=SesionSerialOut)
def cerrar_sesion(
    sesion_id: int,
    body: SesionSerialCerrar | None,
    usuario: Annotated[Usuario, Depends(get_current_user)],
    db: Session = Depends(get_db),
):
    sesion = db.scalars(
        select(SesionSerial)
        .options(joinedload(SesionSerial.usuario))
        .where(SesionSerial.id == sesion_id)
    ).first()
    if not sesion:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    if sesion.usuario_id != usuario.id and usuario.rol != ROL_SUPER:
        raise HTTPException(status_code=403, detail="Sin permiso")

    if sesion.estado == "activa":
        sesion.estado = "cerrada"
        sesion.fin_sync = datetime.now(timezone.utc)
    if body:
        if body.nota is not None:
            sesion.nota = body.nota
        if body.codigo_detectado:
            sesion.codigo_detectado = body.codigo_detectado
        if body.codigo_asignado:
            sesion.codigo_asignado = body.codigo_asignado

    db.commit()
    db.refresh(sesion)
    return _to_out(sesion)


@router.get("", response_model=list[SesionSerialOut])
def listar_sesiones(
    usuario: Annotated[Usuario, Depends(get_current_user)],
    db: Session = Depends(get_db),
    usuario_id: int | None = None,
    limit: int = Query(default=50, le=200),
):
    q = (
        select(SesionSerial)
        .options(joinedload(SesionSerial.usuario))
        .order_by(SesionSerial.inicio_sync.desc())
        .limit(limit)
    )
    if usuario.rol == ROL_SUPER:
        if usuario_id is not None:
            q = q.where(SesionSerial.usuario_id == usuario_id)
    else:
        q = q.where(SesionSerial.usuario_id == usuario.id)

    return [_to_out(s) for s in db.scalars(q).unique().all()]


@router.get("/debug/resumen")
def debug_resumen(
    _: Annotated[Usuario, Depends(require_superusuario)],
    db: Session = Depends(get_db),
):
    from sqlalchemy import func

    total_users = db.scalar(select(func.count()).select_from(Usuario)) or 0
    activos = (
        db.scalar(select(func.count()).select_from(Usuario).where(Usuario.estado == "activo")) or 0
    )
    sesiones_hoy = (
        db.scalar(
            select(func.count())
            .select_from(SesionSerial)
            .where(
                SesionSerial.inicio_sync
                >= datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            )
        )
        or 0
    )
    activas = (
        db.scalar(
            select(func.count()).select_from(SesionSerial).where(SesionSerial.estado == "activa")
        )
        or 0
    )
    return {
        "usuarios_total": total_users,
        "usuarios_activos": activos,
        "sesiones_serial_hoy": sesiones_hoy,
        "sesiones_serial_activas": activas,
        "debug": True,
    }


@router.get("/{sesion_id}", response_model=SesionSerialDetalle)
def detalle_sesion(
    sesion_id: int,
    usuario: Annotated[Usuario, Depends(get_current_user)],
    db: Session = Depends(get_db),
    con_eventos: bool = True,
    limit_eventos: int = Query(default=5000, le=MAX_EVENTOS_DETALLE),
):
    sesion = db.scalars(
        select(SesionSerial)
        .options(joinedload(SesionSerial.usuario))
        .where(SesionSerial.id == sesion_id)
    ).first()
    if not sesion:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    if sesion.usuario_id != usuario.id and usuario.rol != ROL_SUPER:
        raise HTTPException(status_code=403, detail="Sin permiso")

    out = SesionSerialDetalle(**_to_out(sesion).model_dump())
    if con_eventos:
        eventos = db.scalars(
            select(SesionSerialEvento)
            .where(SesionSerialEvento.sesion_id == sesion.id)
            .order_by(SesionSerialEvento.id.asc())
            .limit(limit_eventos)
        ).all()
        out.eventos = list(eventos)
    return out
