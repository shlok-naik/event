"""Registration, login, guest sessions and guest -> user upgrade."""
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import utcnow
from app.errors import Conflict, Unauthorized
from app.models import ACTOR_MODELS, AuthSession, Guest, GuestMagicLink, User
from app.security import (
    Principal,
    create_session,
    hash_password,
    hash_token,
    new_token,
    principal_from_guest,
    principal_from_user,
    revoke_sessions,
    verify_password_or_dummy,
)
from app.services.runtime import rt


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _user_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == normalize_email(email)))


def active_guest_by_email(db: Session, email: str) -> Guest | None:
    return db.scalar(select(Guest).where(Guest.email == normalize_email(email), Guest.upgraded_to_user_id.is_(None)))


def register(db: Session, email: str, password: str, display_name: str) -> tuple[Principal, str]:
    email = normalize_email(email)
    if _user_by_email(db, email):
        raise Conflict("An account with this email already exists", code="email_taken")
    if active_guest_by_email(db, email):
        # Registering over an existing guest would let anyone claim that guest's data.
        # The guest must upgrade from their own (email-verified) guest session instead.
        raise Conflict(
            "This email has guest access. Sign in with the emailed guest link and upgrade from there.",
            code="guest_upgrade_required",
        )
    user = User(email=email, display_name=display_name, password_hash=hash_password(password))
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise Conflict("An account with this email already exists", code="email_taken")
    token = create_session(db, user=user, ttl_days=rt().settings.user_session_ttl_days)
    db.commit()
    return principal_from_user(user), token


def login(db: Session, email: str, password: str) -> tuple[Principal, str]:
    user = _user_by_email(db, email)
    if not verify_password_or_dummy(password, user.password_hash if user else None):
        raise Unauthorized("Incorrect email or password", code="invalid_credentials")
    token = create_session(db, user=user, ttl_days=rt().settings.user_session_ttl_days)
    db.commit()
    return principal_from_user(user), token


def logout(db: Session, principal: Principal) -> None:
    if principal.session_id:
        db.execute(update(AuthSession).where(AuthSession.id == principal.session_id).values(revoked_at=utcnow()))
        db.commit()


def update_display_name(db: Session, principal: Principal, display_name: str) -> Principal:
    person = db.get(User, principal.id) if principal.is_user else db.get(Guest, principal.id)
    person.display_name = display_name
    db.commit()
    return principal_from_user(person) if principal.is_user else principal_from_guest(person)


# --------------------------------------------------------------------------- guest sessions


def request_guest_magic_link(db: Session, email: str) -> None:
    """Email a one-time sign-in link to an existing guest. Silent if the email is unknown
    (so the endpoint cannot be used to discover who has guest access)."""
    guest = active_guest_by_email(db, email)
    if guest is None:
        return
    settings = rt().settings
    token = new_token()
    db.add(
        GuestMagicLink(
            guest_id=guest.id,
            token_hash=hash_token(token),
            expires_at=utcnow() + timedelta(minutes=settings.magic_link_ttl_minutes),
        )
    )
    db.commit()
    link = f"{settings.frontend_base_url}/guest-login?token={token}"
    rt().email.send(
        guest.email,
        "Your sign-in link",
        f"Hi {guest.display_name},\n\nUse this link to get back into your groups:\n{link}\n\n"
        f"It expires in {settings.magic_link_ttl_minutes} minutes and can be used once.",
    )


def exchange_guest_magic_link(db: Session, token: str) -> tuple[Principal, str]:
    now = utcnow()
    # Atomic single-use: only one request can flip used_at from NULL.
    res = db.execute(
        update(GuestMagicLink)
        .where(GuestMagicLink.token_hash == hash_token(token), GuestMagicLink.used_at.is_(None), GuestMagicLink.expires_at > now)
        .values(used_at=now)
    )
    if res.rowcount != 1:
        db.rollback()
        raise Unauthorized("This sign-in link is invalid or has expired", code="invalid_link")
    link = db.scalar(select(GuestMagicLink).where(GuestMagicLink.token_hash == hash_token(token)))
    guest = db.get(Guest, link.guest_id)
    if guest is None or guest.upgraded_to_user_id:
        db.rollback()
        raise Unauthorized("This sign-in link is invalid or has expired", code="invalid_link")
    session_token = create_session(db, guest=guest, ttl_days=rt().settings.guest_session_ttl_days)
    db.commit()
    return principal_from_guest(guest), session_token


def upgrade_guest(db: Session, principal: Principal, password: str, display_name: str | None) -> tuple[Principal, str]:
    """Turn a guest into a registered user, keeping memberships, messages, RSVPs, tasks,
    notifications and preferences (all rows are re-pointed in one transaction)."""
    guest = db.get(Guest, principal.id)
    if _user_by_email(db, guest.email):
        raise Conflict("An account with this email already exists; log in instead", code="email_taken")
    user = User(email=guest.email, display_name=display_name or guest.display_name, password_hash=hash_password(password))
    db.add(user)
    db.flush()
    for model in ACTOR_MODELS:
        db.execute(update(model).where(model.guest_id == guest.id).values(user_id=user.id, guest_id=None))
    guest.upgraded_to_user_id = user.id
    guest.upgraded_at = utcnow()
    revoke_sessions(db, guest_id=guest.id)
    token = create_session(db, user=user, ttl_days=rt().settings.user_session_ttl_days)
    db.commit()
    return principal_from_user(user), token
