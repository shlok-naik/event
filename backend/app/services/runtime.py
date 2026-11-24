"""Process-wide runtime: settings + delivery channels, plus transactional realtime events.

Realtime events are queued on the SQLAlchemy session with :func:`emit` and only sent
once the transaction commits, so clients never hear about changes that were rolled back.
"""
from dataclasses import dataclass

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import GroupMembership
from app.services.delivery import EmailSender, PushClient, RealtimeHub, actor_key


@dataclass
class Runtime:
    settings: Settings
    email: EmailSender
    push: PushClient
    hub: RealtimeHub
    database: object | None = None  # app.db.Database, set by create_app


_runtime: Runtime | None = None


def configure(settings: Settings, push: PushClient | None = None) -> Runtime:
    global _runtime
    _runtime = Runtime(
        settings=settings,
        email=EmailSender(settings),
        push=push or PushClient(settings),
        hub=RealtimeHub(),
    )
    return _runtime


def rt() -> Runtime:
    if _runtime is None:
        raise RuntimeError("Runtime not configured; call app.services.runtime.configure()")
    return _runtime


_PENDING = "pending_realtime"


def emit(db: Session, keys: set[str], payload: dict) -> None:
    """Queue a realtime event for the given principal keys; sent after commit."""
    if keys:
        db.info.setdefault(_PENDING, []).append((set(keys), payload))


def group_member_keys(db: Session, group_ids) -> set[str]:
    rows = db.execute(
        select(GroupMembership.user_id, GroupMembership.guest_id).where(GroupMembership.group_id.in_(list(group_ids)))
    )
    return {actor_key(u, g) for u, g in rows}


def emit_to_groups(db: Session, group_ids, payload: dict) -> None:
    emit(db, group_member_keys(db, group_ids), payload)


@event.listens_for(Session, "after_commit")
def _flush_realtime(session: Session) -> None:
    pending = session.info.pop(_PENDING, None)
    if not pending or _runtime is None:
        return
    for keys, payload in pending:
        _runtime.hub.publish(keys, payload)


@event.listens_for(Session, "after_rollback")
def _drop_realtime(session: Session) -> None:
    session.info.pop(_PENDING, None)
