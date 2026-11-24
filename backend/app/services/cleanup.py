"""Automatic deletion of events after they have taken place.

An event expires at ``expires_at`` (its end - or start + default duration - plus a grace
period). From that moment every read path treats it as gone (see ``access.py``), and the
scheduler then hard-deletes it together with its RSVPs, tasks, assignments, pinned
references, reminders and notifications, and turns its chat cards into
"event no longer available" placeholders.
"""
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import RSVP, Event, EventGroup, Notification, Reminder, Task, TaskAssignment
from app.services import messages as msg_service
from app.services.runtime import emit_to_groups


def delete_events(db: Session, event_ids: list[str], *, notify_members: bool = True) -> None:
    """Delete events and everything attached to them (caller commits).

    Deletes are explicit (not only FK cascades) so behaviour does not depend on the
    database enforcing foreign keys.
    """
    if not event_ids:
        return
    group_ids = list(set(db.scalars(select(EventGroup.group_id).where(EventGroup.event_id.in_(event_ids)))))
    msg_service.invalidate_event_messages(db, event_ids)
    task_ids = select(Task.id).where(Task.event_id.in_(event_ids))
    db.execute(delete(TaskAssignment).where(TaskAssignment.task_id.in_(task_ids)))
    db.execute(delete(Task).where(Task.event_id.in_(event_ids)))
    db.execute(delete(RSVP).where(RSVP.event_id.in_(event_ids)))
    db.execute(delete(Reminder).where(Reminder.event_id.in_(event_ids)))
    db.execute(delete(Notification).where(Notification.event_id.in_(event_ids)))
    db.execute(delete(EventGroup).where(EventGroup.event_id.in_(event_ids)))
    db.execute(delete(Event).where(Event.id.in_(event_ids)))
    db.expire_all()
    if notify_members and group_ids:
        emit_to_groups(db, group_ids, {"type": "event.deleted", "event_ids": event_ids})


def purge_expired_events(db: Session, now: datetime | None = None) -> int:
    now = now or utcnow()
    ids = list(db.scalars(select(Event.id).where(Event.expires_at <= now)))
    delete_events(db, ids)
    db.commit()
    return len(ids)
