"""FastAPI dependencies: database session and the authenticated principal."""
from collections.abc import Iterator

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.errors import Unauthorized
from app.security import Principal, resolve_token
from app.services.runtime import rt

bearer = HTTPBearer(auto_error=False)


def get_db(request: Request) -> Iterator[Session]:
    yield from request.app.state.database.session()


def _resolve(db: Session, token: str) -> Principal:
    s = rt().settings
    return resolve_token(db, token, user_ttl_days=s.user_session_ttl_days, guest_ttl_days=s.guest_session_ttl_days)


def current_principal(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)
) -> Principal:
    if creds is None:
        raise Unauthorized("Missing bearer token")
    return _resolve(db, creds.credentials)


def optional_principal(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)
) -> Principal | None:
    return _resolve(db, creds.credentials) if creds else None


def current_user(principal: Principal = Depends(current_principal)) -> Principal:
    return principal.require_user()


def current_guest(principal: Principal = Depends(current_principal)) -> Principal:
    if not principal.is_guest:
        raise Unauthorized("This action is only for guest sessions", code="guest_only")
    return principal
