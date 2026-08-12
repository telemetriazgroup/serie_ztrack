from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import ROL_SUPER, hash_password
from app.config import settings
from app.models import Usuario


def ensure_superusuario(db: Session) -> None:
    existing = db.scalars(
        select(Usuario).where(Usuario.username == settings.superuser_username)
    ).first()
    if existing:
        # Mantener activo y rol superusuario
        changed = False
        if existing.rol != ROL_SUPER:
            existing.rol = ROL_SUPER
            changed = True
        if existing.estado != "activo":
            existing.estado = "activo"
            existing.archivado_en = None
            changed = True
        if changed:
            db.commit()
        return

    user = Usuario(
        username=settings.superuser_username,
        password_hash=hash_password(settings.superuser_password),
        nombre="ZTrack Superusuario",
        rol=ROL_SUPER,
        estado="activo",
        email="ztrack@local",
    )
    db.add(user)
    db.commit()
