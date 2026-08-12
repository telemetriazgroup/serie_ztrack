from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import hash_password, require_superusuario
from app.database import get_db
from app.models import Usuario
from app.schemas_auth import (
    ArchivarUsuarioRequest,
    UsuarioCreate,
    UsuarioOut,
    UsuarioUpdate,
)

router = APIRouter(prefix="/usuarios", tags=["usuarios"])


@router.get("", response_model=list[UsuarioOut])
def listar_usuarios(
    _: Annotated[Usuario, Depends(require_superusuario)],
    db: Session = Depends(get_db),
    incluir_archivados: bool = True,
):
    q = select(Usuario).order_by(Usuario.creado_en.desc())
    if not incluir_archivados:
        q = q.where(Usuario.estado == "activo")
    return list(db.scalars(q).all())


@router.post("", response_model=UsuarioOut, status_code=status.HTTP_201_CREATED)
def crear_usuario(
    body: UsuarioCreate,
    _: Annotated[Usuario, Depends(require_superusuario)],
    db: Session = Depends(get_db),
):
    exists = db.scalars(select(Usuario).where(Usuario.username == body.username.strip())).first()
    if exists:
        raise HTTPException(status_code=400, detail="El username ya existe")

    user = Usuario(
        username=body.username.strip(),
        password_hash=hash_password(body.password),
        nombre=body.nombre.strip(),
        rol=body.rol,
        email=body.email,
        estado="activo",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.put("/{usuario_id}", response_model=UsuarioOut)
def editar_usuario(
    usuario_id: int,
    body: UsuarioUpdate,
    _: Annotated[Usuario, Depends(require_superusuario)],
    db: Session = Depends(get_db),
):
    user = db.get(Usuario, usuario_id)
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")

    if body.nombre is not None:
        user.nombre = body.nombre.strip()
    if body.email is not None:
        user.email = body.email
    if body.rol is not None:
        user.rol = body.rol
    if body.password:
        user.password_hash = hash_password(body.password)

    db.commit()
    db.refresh(user)
    return user


@router.put("/{usuario_id}/archivar", response_model=UsuarioOut)
def archivar_usuario(
    usuario_id: int,
    actor: Annotated[Usuario, Depends(require_superusuario)],
    db: Session = Depends(get_db),
    body: ArchivarUsuarioRequest | None = None,
):
    user = db.get(Usuario, usuario_id)
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    if user.id == actor.id:
        raise HTTPException(status_code=400, detail="No puedes archivarte a ti mismo")
    if user.username == "ztrack":
        raise HTTPException(status_code=400, detail="No se puede archivar el superusuario ztrack")

    user.estado = "archivado"
    user.archivado_en = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)
    return user


@router.put("/{usuario_id}/activar", response_model=UsuarioOut)
def activar_usuario(
    usuario_id: int,
    _: Annotated[Usuario, Depends(require_superusuario)],
    db: Session = Depends(get_db),
):
    user = db.get(Usuario, usuario_id)
    if not user:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    user.estado = "activo"
    user.archivado_en = None
    db.commit()
    db.refresh(user)
    return user
