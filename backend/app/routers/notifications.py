from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app import schemas as s
from app.deps import current_principal, get_db
from app.security import Principal
from app.services import notifications as svc

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[s.NotificationOut])
def list_notifications(
    unread_only: bool = False,
    before: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    p: Principal = Depends(current_principal),
    db: Session = Depends(get_db),
):
    return svc.list_notifications(db, p, unread_only=unread_only, limit=limit, before=before)


@router.post("/read", response_model=s.OkOut)
def mark_read(body: s.MarkNotificationsReadIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Mark the given notifications (or all, if ``ids`` is omitted) as read."""
    svc.mark_read(db, p, body.ids)
    return {"ok": True}


@router.get("/preferences", response_model=s.NotificationPreferencesOut)
def get_preferences(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return svc.get_preferences(db, p.user_id, p.guest_id)


@router.patch("/preferences", response_model=s.NotificationPreferencesOut)
def update_preferences(body: s.NotificationPreferencesIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return svc.update_preferences(db, p, body.model_dump(exclude_unset=True))
