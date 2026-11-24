from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas as s
from app.deps import current_guest, current_principal, get_db
from app.ratelimit import limit
from app.security import Principal
from app.services import auth as auth_service
from app.services.runtime import rt

router = APIRouter(prefix="/auth", tags=["auth"])


def me_out(p: Principal) -> dict:
    return {"type": p.kind, "id": p.id, "email": p.email, "display_name": p.display_name}


def session_out(p: Principal, token: str) -> dict:
    settings = rt().settings
    ttl = settings.user_session_ttl_days if p.is_user else settings.guest_session_ttl_days
    return {"token": token, "expires_in_days": ttl, "principal": me_out(p)}


@router.post("/register", response_model=s.SessionOut, status_code=201, dependencies=[Depends(limit("register", 10, 3600))])
def register(body: s.RegisterIn, db: Session = Depends(get_db)):
    p, token = auth_service.register(db, body.email, body.password, body.display_name)
    return session_out(p, token)


@router.post("/login", response_model=s.SessionOut, dependencies=[Depends(limit("login", 10, 60))])
def login(body: s.LoginIn, db: Session = Depends(get_db)):
    p, token = auth_service.login(db, body.email, body.password)
    return session_out(p, token)


@router.post("/logout", response_model=s.OkOut)
def logout(principal: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    auth_service.logout(db, principal)
    return {"ok": True}


@router.get("/me", response_model=s.MeOut)
def me(principal: Principal = Depends(current_principal)):
    return me_out(principal)


@router.patch("/me", response_model=s.MeOut)
def update_me(body: s.UpdateMeIn, principal: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return me_out(auth_service.update_display_name(db, principal, body.display_name))


@router.post("/guest/magic-link", response_model=s.OkOut, status_code=202, dependencies=[Depends(limit("magic", 5, 600))])
def guest_magic_link(body: s.MagicLinkRequestIn, db: Session = Depends(get_db)):
    """Email a one-time sign-in link to a guest. Always returns 202 (no account enumeration)."""
    auth_service.request_guest_magic_link(db, body.email)
    return {"ok": True}


@router.post("/guest/session", response_model=s.SessionOut, dependencies=[Depends(limit("guest_session", 10, 60))])
def guest_session(body: s.TokenIn, db: Session = Depends(get_db)):
    """Exchange a magic-link token for a guest session."""
    p, token = auth_service.exchange_guest_magic_link(db, body.token)
    return session_out(p, token)


@router.post("/guest/upgrade", response_model=s.SessionOut, dependencies=[Depends(limit("upgrade", 10, 3600))])
def guest_upgrade(body: s.GuestUpgradeIn, guest: Principal = Depends(current_guest), db: Session = Depends(get_db)):
    """Turn the current guest into a registered account. All data is kept; the guest
    session is revoked and a user session is returned."""
    p, token = auth_service.upgrade_guest(db, guest, body.password, body.display_name)
    return session_out(p, token)
