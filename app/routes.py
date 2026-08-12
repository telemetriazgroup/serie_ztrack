from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import Usuario
from app.schemas import (
    ArchivarRequest,
    EstadisticasOut,
    GenerarResponse,
    ModificarRequest,
    SerieOut,
)
from app import services

router = APIRouter(
    prefix="/serie",
    tags=["serie"],
    dependencies=[Depends(get_current_user)],
)


@router.get("/generar/{serie}", response_model=GenerarResponse)
def generar_serie(serie: str, db: Session = Depends(get_db)):
    registro, ya_asignado = services.generar_o_recuperar(db, serie.strip())

    if ya_asignado:
        mensaje = "El código ya está creado y asignado"
    else:
        mensaje = "Código generado y asignado correctamente"

    return GenerarResponse(
        mensaje=mensaje,
        ya_asignado=ya_asignado,
        serie_origen=registro.serie_origen,
        codigo=registro.codigo,
        estado=registro.estado,
        creado_en=registro.creado_en,
    )


@router.put("/modificar/{codigo}", response_model=SerieOut)
def modificar_codigo(
    codigo: str,
    body: ModificarRequest,
    db: Session = Depends(get_db),
):
    registro = services.modificar_serie(db, codigo, body.nota, body.motivo)
    if not registro:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No se encontró el código {codigo}",
        )
    return registro


@router.put("/archivar/{codigo}", response_model=SerieOut)
def archivar_codigo(
    codigo: str,
    body: ArchivarRequest | None = None,
    db: Session = Depends(get_db),
):
    motivo = body.motivo if body else None
    registro = services.archivar_serie(db, codigo, motivo)
    if not registro:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No se encontró el código {codigo}",
        )
    return registro


@router.get("/ultimo", response_model=SerieOut)
def listar_ultimo(db: Session = Depends(get_db)):
    registro = services.ultimo_codigo(db)
    if not registro:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No hay códigos creados aún",
        )
    return registro


@router.get("/ultimos", response_model=list[SerieOut])
def listar_ultimos(db: Session = Depends(get_db)):
    return services.ultimos_codigos(db, limit=10)


@router.get("/todos", response_model=list[SerieOut])
def listar_todos(db: Session = Depends(get_db)):
    return services.todos_codigos(db)


@router.get("/estadisticas", response_model=EstadisticasOut)
def obtener_estadisticas(
    _: Annotated[Usuario, Depends(get_current_user)],
    db: Session = Depends(get_db),
):
    return services.estadisticas(db)
