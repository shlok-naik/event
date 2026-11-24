from fastapi import APIRouter, Depends, Query, Request

from app import schemas as s
from app.deps import current_principal
from app.ratelimit import limit
from app.security import Principal

router = APIRouter(prefix="/locations", tags=["locations"], dependencies=[Depends(limit("maps", 60, 60, per="principal"))])


@router.get("/search", response_model=list[s.PlaceOut])
def search(
    request: Request,
    q: str = Query(min_length=2, max_length=200),
    lat: float | None = Query(default=None, ge=-90, le=90),
    lng: float | None = Query(default=None, ge=-180, le=180),
    _: Principal = Depends(current_principal),
):
    """Free-text place search (Google Places), optionally biased towards ``lat``/``lng``."""
    near = (lat, lng) if lat is not None and lng is not None else None
    return request.app.state.maps.search(q, near)


@router.get("/geocode", response_model=list[s.PlaceOut])
def geocode(request: Request, address: str = Query(min_length=2, max_length=300), _: Principal = Depends(current_principal)):
    return request.app.state.maps.geocode(address)


@router.get("/reverse", response_model=list[s.PlaceOut])
def reverse(
    request: Request,
    lat: float = Query(ge=-90, le=90),
    lng: float = Query(ge=-180, le=180),
    _: Principal = Depends(current_principal),
):
    return request.app.state.maps.reverse_geocode(lat, lng)
