"""Passwords, opaque session tokens and the ``Principal`` (the user or guest making a request)."""
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import timedelta

import bcrypt
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.errors import Forbidden, Unauthorized
from app.models import AuthSession, Guest, User

# Sessions are only extended ("touched") at most this often, to avoid a write per request.
_TOUCH_INTERVAL = timedelta(minutes=10)


def hash_password(password: str) -> str:
    # bcrypt only uses the first 72 bytes; pre-hash so long passwords are not silently truncated.
    digest = hashlib.sha256(password.encode()).hexdigest().encode()
    return bcrypt.hashpw(digest, bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    digest = hashlib.sha256(password.encode()).hexdigest().encode()
    try:
        return bcrypt.checkpw(digest, password_hash.encode())
    except ValueError:
        return False


# A real hash so login timing is the same whether or not the email exists.
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def verify_password_or_dummy(password: str, password_hash: str | None) -> bool:
    if password_hash is None:
        verify_password(password, _DUMMY_HASH)
        return False
    return verify_password(password, password_hash)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


@dataclass(frozen=True)
class Principal:
    """The authenticated caller: either a registered user or a guest."""

    kind: str  # "user" | "guest"
    id: str
    display_name: str
    email: str
    session_id: str | None = None

    @property
    def is_user(self) -> bool:
        return self.kind == "user"

    @property
    def is_guest(self) -> bool:
        return self.kind == "guest"

    @property
    def user_id(self) -> str | None:
        return self.id if self.is_user else None

    @property
    def guest_id(self) -> str | None:
        return self.id if self.is_guest else None

    def actor_values(self) -> dict:
        """Column values for an ``ActorMixin`` row owned by this principal."""
        return {"user_id": self.user_id, "guest_id": self.guest_id}

    def owns(self, model):
        """SQL condition: ``model`` row belongs to this principal."""
        if self.is_user:
            return and_(model.user_id == self.id, model.guest_id.is_(None))
        return and_(model.guest_id == self.id, model.user_id.is_(None))

    def is_actor_of(self, row) -> bool:
        return (row.user_id == self.user_id) and (row.guest_id == self.guest_id)

    def require_user(self) -> "Principal":
        if not self.is_user:
            raise Forbidden("This action requires a registered account", code="registration_required")
        return self


def principal_from_user(user: User, session_id: str | None = None) -> Principal:
    return Principal("user", user.id, user.display_name, user.email, session_id)


def principal_from_guest(guest: Guest, session_id: str | None = None) -> Principal:
    return Principal("guest", guest.id, guest.display_name, guest.email, session_id)


def create_session(db: Session, *, user: User | None = None, guest: Guest | None = None, ttl_days: int) -> str:
    """Create a session and return the raw bearer token (shown to the client once)."""
    token = new_token()
    now = utcnow()
    db.add(
        AuthSession(
            token_hash=hash_token(token),
            user_id=user.id if user else None,
            guest_id=guest.id if guest else None,
            created_at=now,
            last_used_at=now,
            expires_at=now + timedelta(days=ttl_days),
        )
    )
    return token


def resolve_token(db: Session, token: str, *, user_ttl_days: int, guest_ttl_days: int) -> Principal:
    """Look up a bearer token. Sessions slide: each use (at most every 10 min) extends expiry."""
    if not token:
        raise Unauthorized("Missing bearer token")
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    now = utcnow()
    if session is None or session.revoked_at is not None or session.expires_at <= now:
        raise Unauthorized("Invalid or expired session", code="invalid_session")

    if session.user_id:
        user = db.get(User, session.user_id)
        if user is None:
            raise Unauthorized("Invalid or expired session", code="invalid_session")
        principal = principal_from_user(user, session.id)
        ttl = user_ttl_days
    else:
        guest = db.get(Guest, session.guest_id)
        if guest is None or guest.upgraded_to_user_id is not None:
            raise Unauthorized("Invalid or expired session", code="invalid_session")
        principal = principal_from_guest(guest, session.id)
        ttl = guest_ttl_days

    if now - session.last_used_at > _TOUCH_INTERVAL:
        session.last_used_at = now
        session.expires_at = now + timedelta(days=ttl)
        db.commit()
    return principal


def revoke_sessions(db: Session, *, user_id: str | None = None, guest_id: str | None = None) -> None:
    now = utcnow()
    q = select(AuthSession).where(AuthSession.revoked_at.is_(None))
    if user_id:
        q = q.where(AuthSession.user_id == user_id)
    if guest_id:
        q = q.where(AuthSession.guest_id == guest_id)
    for s in db.scalars(q):
        s.revoked_at = now
