"""Group messaging: history, sending, unread tracking and interactive event messages."""
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session, selectinload

from app.db import utcnow
from app.models import RSVP, Event, EventGroup, EventStatus, GroupMembership, Message, MessageKind
from app.security import Principal
from app.services.access import require_member
from app.services.runtime import emit_to_groups


def actor_out(user, guest) -> dict | None:
    if user is not None:
        return {"type": "user", "id": user.id, "display_name": user.display_name}
    if guest is not None:
        return {"type": "guest", "id": guest.id, "display_name": guest.display_name}
    return None


def location_out(obj) -> dict | None:
    name = getattr(obj, "location_name", None)
    address = getattr(obj, "address", None)
    if obj.latitude is None and not name and not address:
        return None
    return {
        "name": name,
        "address": address,
        "latitude": obj.latitude,
        "longitude": obj.longitude,
        "place_id": obj.place_id,
    }


def event_summary(event: Event, my_rsvp: bool) -> dict:
    return {
        "id": event.id,
        "name": event.name,
        "starts_at": event.starts_at,
        "ends_at": event.ends_at,
        "location": location_out(event),
        "status": event.status,
        "participant_count": event.participant_count,
        "min_participants": event.min_participants,
        "max_participants": event.max_participants,
        "min_reached": event.participant_count >= event.min_participants,
        "is_full": event.max_participants is not None and event.participant_count >= event.max_participants,
        "my_rsvp": my_rsvp,
    }


def serialize_messages(db: Session, principal: Principal | None, messages: list[Message]) -> list[dict]:
    """Serialise messages; event messages get a live event summary (counts, my RSVP)."""
    now = utcnow()
    event_ids = {m.event_id for m in messages if m.event_id}
    events = {}
    mine = set()
    if event_ids:
        events = {e.id: e for e in db.scalars(select(Event).where(Event.id.in_(event_ids), Event.expires_at > now))}
        if principal is not None:
            mine = set(db.scalars(select(RSVP.event_id).where(RSVP.event_id.in_(event_ids), principal.owns(RSVP))))
    out = []
    for m in messages:
        kind = m.kind
        summary = None
        if kind == MessageKind.EVENT:
            ev = events.get(m.event_id)
            if ev is None:
                kind = MessageKind.EVENT_EXPIRED  # expired but not yet purged: never expose it
            else:
                summary = event_summary(ev, ev.id in mine)
        out.append(
            {
                "id": m.id,
                "group_id": m.group_id,
                "kind": kind,
                "body": m.body if kind != MessageKind.EVENT_EXPIRED else "This event has ended and is no longer available.",
                "sender": actor_out(m.user, m.guest),
                "created_at": m.created_at,
                "event": summary,
            }
        )
    return out


def _publish_message(db: Session, message: Message) -> None:
    payload = serialize_messages(db, None, [message])[0]
    emit_to_groups(db, [message.group_id], {"type": "message.created", "message": payload})


def history(db: Session, principal: Principal, group_id: str, *, before_id: int | None, limit: int) -> tuple[list[dict], bool]:
    require_member(db, principal, group_id)
    q = select(Message).options(selectinload(Message.user), selectinload(Message.guest)).where(Message.group_id == group_id)
    if before_id is not None:
        q = q.where(Message.id < before_id)
    rows = db.scalars(q.order_by(Message.id.desc()).limit(limit + 1)).all()
    has_more = len(rows) > limit
    rows = list(reversed(rows[:limit]))
    return serialize_messages(db, principal, rows), has_more


def send(db: Session, principal: Principal, group_id: str, body: str) -> dict:
    require_member(db, principal, group_id)
    msg = Message(group_id=group_id, kind=MessageKind.TEXT, body=body, **principal.actor_values())
    db.add(msg)
    db.flush()
    # The sender has obviously read their own message.
    db.execute(
        update(GroupMembership)
        .where(GroupMembership.group_id == group_id, principal.owns(GroupMembership))
        .values(last_read_message_id=msg.id)
    )
    db.refresh(msg)
    _publish_message(db, msg)
    db.commit()
    return serialize_messages(db, principal, [msg])[0]


def post_system_message(db: Session, group_id: str, body: str) -> Message:
    msg = Message(group_id=group_id, kind=MessageKind.SYSTEM, body=body)
    db.add(msg)
    db.flush()
    _publish_message(db, msg)
    return msg


def post_event_message(db: Session, principal: Principal, group_id: str, event: Event) -> Message:
    msg = Message(group_id=group_id, kind=MessageKind.EVENT, body=f"New event: {event.name}", event_id=event.id, **principal.actor_values())
    db.add(msg)
    db.flush()
    db.refresh(msg)
    _publish_message(db, msg)
    return msg


def mark_read(db: Session, principal: Principal, group_id: str, message_id: int) -> int:
    m = require_member(db, principal, group_id)
    latest = db.scalar(select(func.max(Message.id)).where(Message.group_id == group_id)) or 0
    target = min(message_id, latest)
    if target > m.last_read_message_id:  # read position never moves backwards
        m.last_read_message_id = target
    db.commit()
    return unread_count(db, principal, group_id, m.last_read_message_id)


def unread_count(db: Session, principal: Principal, group_id: str, last_read: int) -> int:
    return db.scalar(
        select(func.count(Message.id)).where(
            Message.group_id == group_id,
            Message.id > last_read,
            # Own messages never count as unread.
            or_(Message.user_id.is_(None), Message.user_id != principal.user_id) if principal.is_user
            else or_(Message.guest_id.is_(None), Message.guest_id != principal.guest_id),
        )
    ) or 0


def pinned_events(db: Session, principal: Principal, group_id: str) -> list[dict]:
    """Upcoming, active, pinned events of a group, soonest first."""
    require_member(db, principal, group_id)
    now = utcnow()
    events = db.scalars(
        select(Event)
        .join(EventGroup, EventGroup.event_id == Event.id)
        .where(
            EventGroup.group_id == group_id,
            EventGroup.pinned.is_(True),
            Event.status == EventStatus.ACTIVE,
            Event.expires_at > now,
        )
        .order_by(Event.starts_at)
    ).all()
    mine = set(db.scalars(select(RSVP.event_id).where(RSVP.event_id.in_([e.id for e in events]), principal.owns(RSVP))))
    return [event_summary(e, e.id in mine) for e in events]


def invalidate_event_messages(db: Session, event_ids: list[str]) -> list[tuple[str, int]]:
    """Turn event cards into 'expired' placeholders and drop their event reference."""
    rows = db.execute(select(Message.group_id, Message.id).where(Message.event_id.in_(event_ids))).all()
    db.execute(
        update(Message).where(Message.event_id.in_(event_ids)).values(
            kind=MessageKind.EVENT_EXPIRED, event_id=None, body="This event has ended and is no longer available."
        )
    )
    return [(g, i) for g, i in rows]


def group_last_message_at(db: Session, group_ids: list[str]) -> dict[str, object]:
    rows = db.execute(select(Message.group_id, func.max(Message.created_at)).where(Message.group_id.in_(group_ids)).group_by(Message.group_id))
    return dict(rows.all())

