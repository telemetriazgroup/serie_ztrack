from datetime import datetime, timedelta, timezone
from typing import Annotated
from uuid import uuid4

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import SesionAuth, Usuario

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)

ROL_SUPER = "superusuario"
ROL_OPERADOR = "operador"


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def crear_token(usuario: Usuario, jti: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(usuario.id),
        "username": usuario.username,
        "rol": usuario.rol,
        "jti": jti,
        "iat": now,
        "exp": now + timedelta(hours=settings.jwt_expire_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decodificar_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expirado") from e
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido") from e


def client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


def get_current_user(
    request: Request,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> Usuario:
    if not creds or not creds.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No autenticado")

    payload = decodificar_token(creds.credentials)
    jti = payload.get("jti")
    user_id = payload.get("sub")
    if not jti or not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido")

    sesion = db.scalars(select(SesionAuth).where(SesionAuth.jti == jti)).first()
    if not sesion or not sesion.activa:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesión cerrada o inválida")

    usuario = db.get(Usuario, int(user_id))
    if not usuario or usuario.estado != "activo":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario inactivo")

    sesion.ultimo_acceso = datetime.now(timezone.utc)
    db.commit()
    request.state.sesion_auth_id = sesion.id
    request.state.jti = jti
    return usuario


def require_superusuario(usuario: Annotated[Usuario, Depends(get_current_user)]) -> Usuario:
    if usuario.rol != ROL_SUPER:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo superusuario")
    return usuario


def nueva_jti() -> str:
    return uuid4().hex
