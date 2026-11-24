"""Events: create, edit, cancel, share to more groups, read, and calendar export.

An event shared to several groups is ONE ``Event`` row with several ``EventGroup`` rows,
so RSVPs and tasks (which hang off the event) are automatically shared everywhere.
"""
from datetime import datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.db import utcnow
from app.errors import BadRequest, Conflict, NotFound
from app.models import (
    RSVP,
    Event,
    EventGroup,
    EventStatus,
    GroupMembership,
    NotificationKind,
    Reminder,
    Task,
    User,
)
from app.security import Principal
from app.services import messages as msg_service
from app.services import reminders as reminder_service
from app.services.access import can_access_event_condition, get_accessible_event, member_group_ids, require_event_creator, require_member
from app.services.notifications import notify
from app.services.runtime import emit_to_groups, rt


def compute_expires_at(starts_at: datetime, ends_at: datetime | None) -> datetime:
    s = rt().settings
    end = ends_at or starts_at + timedelta(hours=s.event_default_duration_hours)
    return end + timedelta(hours=s.event_delete_grace_hours)


def event_group_ids(db: Session, event_id: str) -> list[str]:
    return list(db.scalars(select(EventGroup.group_id).where(EventGroup.event_id == event_id)))


def participant_recipients(db: Session, event_id: str) -> list[tuple]:
    return [tuple(r) for r in db.execute(select(RSVP.user_id, RSVP.guest_id).where(RSVP.event_id == event_id))]


def group_recipients(db: Session, group_ids: list[str]) -> list[tuple]:
    return [tuple(r) for r in db.execute(select(GroupMembership.user_id, GroupMembership.guest_id).where(GroupMembership.group_id.in_(group_ids)))]


def _apply_location(event: Event, loc) -> None:
    if loc is None:
        event.location_name = event.address = event.latitude = event.longitude = event.place_id = None
        return
    event.location_name = loc.name
    event.address = loc.address
    event.latitude = loc.latitude
    event.longitude = loc.longitude
    event.place_id = loc.place_id


def _share_to_groups(db: Session, principal: Principal, event: Event, group_ids: list[str]) -> list[str]:
    added = []
    existing = set(event_group_ids(db, event.id))
    for gid in dict.fromkeys(group_ids):
        if gid in existing:
            continue
        require_member(db, principal, gid)  # 404 for groups the creator is not in
        msg = msg_service.post_event_message(db, principal, gid, event)
        db.add(EventGroup(event_id=event.id, group_id=gid, pinned=True, message_id=msg.id))
        added.append(gid)
    if added:
        notify(
            db,
            group_recipients(db, added),
            NotificationKind.NEW_EVENT,
            f"New event: {event.name}",
            f"{principal.display_name} created an event on {event.starts_at:%a %d %b, %H:%M} UTC",
            data={"event_id": event.id, "group_ids": added},
            event_id=event.id,
            exclude=principal,
        )
    return added


def create_event(db: Session, principal: Principal, data) -> Event:
    principal.require_user()
    if data.starts_at <= utcnow():
        raise BadRequest("starts_at must be in the future")
    group_ids = list(dict.fromkeys(data.group_ids))
    for gid in group_ids:
        require_member(db, principal, gid)
    event = Event(
        creator_user_id=principal.id,
        name=data.name,
        description=data.description,
        starts_at=data.starts_at,
        ends_at=data.ends_at,
        min_participants=data.min_participants,
        max_participants=data.max_participants,
        expires_at=compute_expires_at(data.starts_at, data.ends_at),
    )
    _apply_location(event, data.location)
    db.add(event)
    db.flush()
    _share_to_groups(db, principal, event, group_ids)
    emit_to_groups(db, group_ids, {"type": "event.created", "event_id": event.id})
    db.commit()
    return event


def share_event(db: Session, principal: Principal, event_id: str, group_ids: list[str]) -> Event:
    event = require_event_creator(db, principal, event_id)
    if event.status != EventStatus.ACTIVE:
        raise Conflict("Cancelled events cannot be shared")
    added = _share_to_groups(db, principal, event, group_ids)
    emit_to_groups(db, added, {"type": "event.created", "event_id": event.id})
    db.commit()
    return event


def update_event(db: Session, principal: Principal, event_id: str, data) -> Event:
    event = require_event_creator(db, principal, event_id)
    if event.status != EventStatus.ACTIVE:
        raise Conflict("Cancelled events cannot be edited")
    fields = data.model_dump(exclude_unset=True)
    for key in ("name", "starts_at", "min_participants"):
        if key in fields and fields[key] is None:
            raise BadRequest(f"{key} cannot be null")

    starts_at = fields.get("starts_at", event.starts_at)
    ends_at = fields.get("ends_at", event.ends_at)
    min_p = fields.get("min_participants", event.min_participants)
    max_p = fields.get("max_participants", event.max_participants)
    if "starts_at" in fields and starts_at <= utcnow():
        raise BadRequest("starts_at must be in the future")
    if ends_at is not None and ends_at <= starts_at:
        raise BadRequest("ends_at must be after starts_at")
    if max_p is not None and max_p < min_p:
        raise BadRequest("max_participants must be >= min_participants")
    if max_p is not None and max_p < event.participant_count:
        raise Conflict(f"{event.participant_count} people are already going; max_participants cannot be lower", code="max_below_participants")

    changed = []
    for key in ("name", "description", "starts_at", "ends_at", "min_participants", "max_participants"):
        if key in fields and getattr(event, key) != fields[key]:
            setattr(event, key, fields[key])
            changed.append(key)
    if "location" in fields:
        _apply_location(event, data.location)
        changed.append("location")
    if not changed:
        return event

    time_changed = "starts_at" in changed or "ends_at" in changed
    if time_changed:
        event.expires_at = compute_expires_at(event.starts_at, event.ends_at)
        reminder_service.reschedule_event_reminders(db, event)
    if event.participant_count < event.min_participants:
        event.min_reached_at = None
    elif event.min_reached_at is None:
        event.min_reached_at = utcnow()

    notify(
        db,
        participant_recipients(db, event.id),
        NotificationKind.EVENT_UPDATED,
        f"{event.name} was updated",
        "Changed: " + ", ".join(c.replace("_", " ") for c in changed),
        data={"event_id": event.id, "changed": changed},
        event_id=event.id,
        exclude=principal,
    )
    emit_to_groups(db, event_group_ids(db, event.id), {"type": "event.updated", "event_id": event.id, "changed": changed})
    db.commit()
    return event


def cancel_event(db: Session, principal: Principal, event_id: str) -> Event:
    event = require_event_creator(db, principal, event_id)
    if event.status == EventStatus.CANCELLED:
        return event
    event.status = EventStatus.CANCELLED
    event.cancelled_at = utcnow()
    db.execute(update(Reminder).where(Reminder.event_id == event.id, Reminder.sent_at.is_(None)).values(cancelled_at=utcnow()))
    db.execute(update(EventGroup).where(EventGroup.event_id == event.id).values(pinned=False))
    gids = event_group_ids(db, event.id)
    for gid in gids:
        msg_service.post_system_message(db, gid, f"{event.name} has been cancelled")
    notify(
        db,
        participant_recipients(db, event.id),
        NotificationKind.EVENT_CANCELLED,
        f"{event.name} was cancelled",
        f"{principal.display_name} cancelled the event.",
        data={"event_id": event.id},
        event_id=event.id,
        exclude=principal,
    )
    emit_to_groups(db, gids, {"type": "event.cancelled", "event_id": event.id})
    db.commit()
    return event


def set_pinned(db: Session, principal: Principal, event_id: str, group_id: str, pinned: bool) -> None:
    from app.services.access import require_group_admin

    get_accessible_event(db, principal, event_id)
    require_group_admin(db, principal, group_id)
    eg = db.scalar(select(EventGroup).where(EventGroup.event_id == event_id, EventGroup.group_id == group_id))
    if eg is None:
        raise NotFound("Event is not shared to this group")
    eg.pinned = pinned
    emit_to_groups(db, [group_id], {"type": "event.updated", "event_id": event_id, "changed": ["pinned"]})
    db.commit()


# --------------------------------------------------------------------------- reading


def task_counts(db: Session, event_ids: list[str]) -> dict[str, dict[str, int]]:
    out = {eid: {"open": 0, "claimed": 0, "completed": 0} for eid in event_ids}
    for eid, status, n in db.execute(select(Task.event_id, Task.status, func.count()).where(Task.event_id.in_(event_ids)).group_by(Task.event_id, Task.status)):
        out[eid][status] = n
    return out


def event_out(db: Session, principal: Principal, event: Event) -> dict:
    my_groups = set(db.scalars(member_group_ids(principal)))
    gids = [g for g in event_group_ids(db, event.id) if g in my_groups]
    mine = db.scalar(select(RSVP.id).where(RSVP.event_id == event.id, principal.owns(RSVP))) is not None
    creator = db.get(User, event.creator_user_id)
    return {
        **msg_service.event_summary(event, mine),
        "description": event.description,
        "creator": msg_service.actor_out(creator, None),
        "group_ids": gids,
        "is_creator": principal.is_user and principal.id == event.creator_user_id,
        "created_at": event.created_at,
        "updated_at": event.updated_at,
        "task_counts": task_counts(db, [event.id])[event.id],
    }


def get_event(db: Session, principal: Principal, event_id: str) -> dict:
    return event_out(db, principal, get_accessible_event(db, principal, event_id))


def list_events(db: Session, principal: Principal, *, group_id: str | None, include_cancelled: bool) -> list[dict]:
    q = select(Event).where(Event.expires_at > utcnow(), can_access_event_condition(principal))
    if group_id:
        require_member(db, principal, group_id)
        q = q.where(Event.id.in_(select(EventGroup.event_id).where(EventGroup.group_id == group_id)))
    if not include_cancelled:
        q = q.where(Event.status == EventStatus.ACTIVE)
    return [event_out(db, principal, e) for e in db.scalars(q.order_by(Event.starts_at))]


def list_participants(db: Session, principal: Principal, event_id: str) -> list[dict]:
    from sqlalchemy.orm import selectinload

    get_accessible_event(db, principal, event_id)
    rows = db.scalars(select(RSVP).options(selectinload(RSVP.user), selectinload(RSVP.guest)).where(RSVP.event_id == event_id).order_by(RSVP.created_at))
    return [{"actor": msg_service.actor_out(r.user, r.guest), "rsvp_at": r.created_at} for r in rows]


def _ics_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def to_ics(db: Session, principal: Principal, event_id: str) -> str:
    """iCalendar file for adding the event to Google/Apple/Outlook calendars."""
    e = get_accessible_event(db, principal, event_id)
    fmt = "%Y%m%dT%H%M%SZ"
    end = e.ends_at or e.starts_at + timedelta(hours=rt().settings.event_default_duration_hours)
    location = ", ".join(x for x in (e.location_name, e.address) if x)
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Event App//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:{e.id}@event-app",
        f"DTSTAMP:{utcnow().strftime(fmt)}",
        f"DTSTART:{e.starts_at.strftime(fmt)}",
        f"DTEND:{end.strftime(fmt)}",
        f"SUMMARY:{_ics_escape(e.name)}",
        f"STATUS:{'CANCELLED' if e.status == EventStatus.CANCELLED else 'CONFIRMED'}",
    ]
    if e.description:
        lines.append(f"DESCRIPTION:{_ics_escape(e.description)}")
    if location:
        lines.append(f"LOCATION:{_ics_escape(location)}")
    if e.latitude is not None:
        lines.append(f"GEO:{e.latitude};{e.longitude}")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(lines) + "\r\n"
