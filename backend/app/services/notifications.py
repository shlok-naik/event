"""Notifications: in-app records, realtime pushes, the external push API and email.

``notify`` writes ``Notification`` rows inside the caller's transaction (respecting each
recipient's preferences). Rows with ``pushed_at IS NULL`` form an outbox that
``flush_push_outbox`` delivers to the push API / email after commit, and the scheduler
retries anything left over.
"""
import logging
import threading
from datetime import timedelta

from sqlalchemy import event as sa_event
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Guest, Notification, NotificationKind, NotificationPreference, User, new_id
from app.security import Principal
from app.services.delivery import actor_key
from app.services.runtime import emit, rt

log = logging.getLogger("event.notifications")

PREFERENCE_FOR_KIND = {
    NotificationKind.GROUP_INVITE: "group_invites",
    NotificationKind.NEW_EVENT: "new_events",
    NotificationKind.EVENT_REMINDER: "event_reminders",
    NotificationKind.TASK_REMINDER: "task_reminders",
    NotificationKind.EVENT_UPDATED: "event_updates",
    NotificationKind.EVENT_CANCELLED: "event_updates",
    NotificationKind.MIN_PARTICIPANTS_REACHED: "event_updates",
    NotificationKind.SMART_REMINDER: "smart_reminders",
}

Recipient = tuple[str | None, str | None]  # (user_id, guest_id)


DEFAULT_PREFERENCES = dict(
    group_invites=True,
    new_events=True,
    event_reminders=True,
    task_reminders=True,
    event_updates=True,
    smart_reminders=True,
    push_enabled=True,
    email_enabled=False,
    reminder_lead_hours=24,
)


def get_preferences(db: Session, user_id: str | None, guest_id: str | None) -> NotificationPreference:
    """Stored preferences, or (unsaved) defaults if the person never changed them."""
    q = select(NotificationPreference)
    q = q.where(NotificationPreference.user_id == user_id) if user_id else q.where(NotificationPreference.guest_id == guest_id)
    pref = db.scalar(q)
    if pref is None:
        pref = NotificationPreference(user_id=user_id, guest_id=guest_id, **DEFAULT_PREFERENCES)
    return pref


def update_preferences(db: Session, principal: Principal, changes: dict) -> NotificationPreference:
    pref = db.scalar(select(NotificationPreference).where(principal.owns(NotificationPreference)))
    if pref is None:
        pref = get_preferences(db, principal.user_id, principal.guest_id)
        db.add(pref)
    for k, v in changes.items():
        if v is not None:
            setattr(pref, k, v)
    db.commit()
    return pref


def wants(pref: NotificationPreference, kind: str) -> bool:
    field = PREFERENCE_FOR_KIND.get(kind)
    return True if field is None else bool(getattr(pref, field))


def serialize(n: Notification) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "title": n.title,
        "body": n.body,
        "data": n.data,
        "group_id": n.group_id,
        "event_id": n.event_id,
        "created_at": n.created_at,
        "read_at": n.read_at,
    }


def notify(
    db: Session,
    recipients: list[Recipient],
    kind: str,
    title: str,
    body: str = "",
    *,
    data: dict | None = None,
    group_id: str | None = None,
    event_id: str | None = None,
    exclude: Principal | None = None,
) -> list[Notification]:
    created = []
    seen = set()
    now = utcnow()
    for user_id, guest_id in recipients:
        key = actor_key(user_id, guest_id)
        if key in seen:
            continue
        seen.add(key)
        if exclude is not None and exclude.user_id == user_id and exclude.guest_id == guest_id:
            continue
        if not wants(get_preferences(db, user_id, guest_id), kind):
            continue
        n = Notification(
            id=new_id(),
            user_id=user_id,
            guest_id=guest_id,
            kind=kind,
            title=title[:200],
            body=body[:1000],
            data=data or {},
            group_id=group_id,
            event_id=event_id,
            created_at=now,
        )
        db.add(n)
        created.append(n)
        emit(db, {key}, {"type": "notification.created", "notification": serialize(n)})
    if created:
        db.info["push_pending"] = True
    return created


# --------------------------------------------------------------------------- outbox

_flush_lock = threading.Lock()


def flush_push_outbox(db: Session, limit: int = 500) -> int:
    """Deliver undelivered notifications to the push API (and email, if enabled)."""
    runtime = rt()
    with _flush_lock:
        cutoff = utcnow() - timedelta(days=1)
        pending = db.scalars(
            select(Notification)
            .where(Notification.pushed_at.is_(None), Notification.created_at > cutoff)
            .order_by(Notification.created_at)
            .limit(limit)
        ).all()
        sent = 0
        for n in pending:
            pref = get_preferences(db, n.user_id, n.guest_id)
            ok = True
            if pref.push_enabled:
                ok = runtime.push.send(
                    {
                        "id": n.id,
                        "recipient": {"type": "user" if n.user_id else "guest", "id": n.user_id or n.guest_id},
                        **{k: v for k, v in serialize(n).items() if k != "id"},
                    }
                )
            if pref.email_enabled:
                person = db.get(User, n.user_id) if n.user_id else db.get(Guest, n.guest_id)
                if person is not None:
                    try:
                        runtime.email.send(person.email, n.title, n.body)
                    except Exception as exc:  # email failure must not block push delivery
                        log.warning("Notification email failed: %s", exc)
            if ok:
                db.execute(update(Notification).where(Notification.id == n.id).values(pushed_at=utcnow()))
                sent += 1
        db.commit()
        return sent


def _flush_in_new_session() -> None:
    runtime = rt()
    database = getattr(runtime, "database", None)
    if database is None:
        return
    db = database.SessionLocal()
    try:
        flush_push_outbox(db)
    except Exception:
        log.exception("Push outbox flush failed")
    finally:
        db.close()


@sa_event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    if not session.info.pop("push_pending", False):
        return
    try:
        runtime = rt()
    except RuntimeError:
        return
    if runtime.settings.push_async:
        threading.Thread(target=_flush_in_new_session, daemon=True).start()
    else:
        _flush_in_new_session()


@sa_event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    session.info.pop("push_pending", None)


# --------------------------------------------------------------------------- reading


def list_notifications(db: Session, principal: Principal, *, unread_only: bool, limit: int, before=None):
    q = select(Notification).where(principal.owns(Notification))
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    if before is not None:
        q = q.where(Notification.created_at < before)
    return db.scalars(q.order_by(Notification.created_at.desc()).limit(limit)).all()


def mark_read(db: Session, principal: Principal, ids: list[str] | None) -> int:
    stmt = update(Notification).where(principal.owns(Notification), Notification.read_at.is_(None))
    if ids is not None:
        stmt = stmt.where(Notification.id.in_(ids))
    res = db.execute(stmt.values(read_at=utcnow()))
    db.commit()
    return res.rowcount
