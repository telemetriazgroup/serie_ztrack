from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import (
    client_ip,
    crear_token,
    get_current_user,
    nueva_jti,
    require_superusuario,
    verify_password,
)
from app.database import get_db
from app.models import SesionAuth, Usuario
from app.schemas_auth import LoginRequest, LoginResponse, SesionAuthOut, UsuarioOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    usuario = db.scalars(select(Usuario).where(Usuario.username == body.username.strip())).first()
    if not usuario or not verify_password(body.password, usuario.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Credenciales inválidas")
    if usuario.estado != "activo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Usuario archivado")

    jti = nueva_jti()
    ip = client_ip(request)
    ua = request.headers.get("user-agent")
    lugar = body.lugar

    sesion = SesionAuth(
        usuario_id=usuario.id,
        jti=jti,
        ip=ip,
        user_agent=ua,
        lugar=lugar,
        activa=True,
    )
    db.add(sesion)
    db.commit()
    db.refresh(sesion)

    token = crear_token(usuario, jti)
    return LoginResponse(
        access_token=token,
        usuario=UsuarioOut.model_validate(usuario),
        sesion_auth_id=sesion.id,
        ip=ip,
        lugar=lugar,
    )


@router.post("/logout")
def logout(
    request: Request,
    usuario: Annotated[Usuario, Depends(get_current_user)],
    db: Session = Depends(get_db),
):
    jti = getattr(request.state, "jti", None)
    if jti:
        sesion = db.scalars(select(SesionAuth).where(SesionAuth.jti == jti)).first()
        if sesion and sesion.activa:
            sesion.activa = False
            sesion.fin = datetime.now(timezone.utc)
            db.commit()
    return {"mensaje": "Sesión cerrada", "usuario": usuario.username}


@router.get("/me", response_model=UsuarioOut)
def me(usuario: Annotated[Usuario, Depends(get_current_user)]):
    return usuario


@router.get("/sesiones", response_model=list[SesionAuthOut])
def mis_sesiones_auth(
    usuario: Annotated[Usuario, Depends(get_current_user)],
    db: Session = Depends(get_db),
    todas: bool = False,
):
    q = select(SesionAuth).order_by(SesionAuth.inicio.desc())
    if not (todas and usuario.rol == "superusuario"):
        q = q.where(SesionAuth.usuario_id == usuario.id)
    return list(db.scalars(q.limit(100)).all())


@router.get("/sesiones/activas", response_model=list[SesionAuthOut])
def sesiones_activas(
    _: Annotated[Usuario, Depends(require_superusuario)],
    db: Session = Depends(get_db),
):
    return list(
        db.scalars(
            select(SesionAuth)
            .where(SesionAuth.activa.is_(True))
            .order_by(SesionAuth.ultimo_acceso.desc())
        ).all()
    )
