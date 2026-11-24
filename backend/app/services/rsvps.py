"""RSVPs, safe under concurrency.

The participant counter on ``events`` is changed with a single conditional UPDATE
(``... WHERE participant_count < max_participants``). That statement is atomic in SQLite
and takes a row lock in PostgreSQL, so two people can never both take the last place.
The unique (event, person) constraint on ``rsvps`` is the backstop against duplicates;
if it fires, the whole transaction (including the counter bump) is rolled back.
"""
from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import utcnow
from app.errors import Conflict
from app.models import RSVP, Event, EventStatus, NotificationKind, Reminder, Task, TaskAssignment, TaskStatus
from app.security import Principal
from app.services import reminders as reminder_service
from app.services.access import get_accessible_event, is_participant
from app.services.events import event_group_ids, participant_recipients
from app.services.notifications import notify
from app.services.runtime import emit_to_groups


def rsvp_state(event: Event, participating: bool) -> dict:
    return {
        "event_id": event.id,
        "participating": participating,
        "participant_count": event.participant_count,
        "min_participants": event.min_participants,
        "max_participants": event.max_participants,
        "min_reached": event.participant_count >= event.min_participants,
        "is_full": event.max_participants is not None and event.participant_count >= event.max_participants,
    }


def _broadcast(db: Session, event: Event) -> None:
    state = rsvp_state(event, False)
    state.pop("participating")
    emit_to_groups(db, event_group_ids(db, event.id), {"type": "rsvp.changed", **state})


def join(db: Session, principal: Principal, event_id: str) -> dict:
    event = get_accessible_event(db, principal, event_id)
    if event.status != EventStatus.ACTIVE:
        raise Conflict("This event was cancelled", code="event_cancelled")
    if event.starts_at <= utcnow():
        raise Conflict("This event has already started", code="event_started")
    if is_participant(db, principal, event_id):
        raise Conflict("You are already going to this event", code="already_participating")

    res = db.execute(
        update(Event)
        .where(
            Event.id == event_id,
            Event.status == EventStatus.ACTIVE,
            or_(Event.max_participants.is_(None), Event.participant_count < Event.max_participants),
        )
        .values(participant_count=Event.participant_count + 1)
    )
    if res.rowcount != 1:
        db.rollback()
        raise Conflict("This event is full", code="event_full")
    try:
        db.add(RSVP(event_id=event_id, **principal.actor_values()))
        db.flush()
    except IntegrityError:
        db.rollback()  # also undoes the counter increment
        raise Conflict("You are already going to this event", code="already_participating")

    db.refresh(event)
    # Exactly one RSVP "wins" the min-reached transition, so the notification is sent once.
    if event.participant_count >= event.min_participants:
        won = db.execute(
            update(Event).where(Event.id == event_id, Event.min_reached_at.is_(None)).values(min_reached_at=utcnow())
        ).rowcount
        if won:
            notify(
                db,
                participant_recipients(db, event_id) + [(event.creator_user_id, None)],
                NotificationKind.MIN_PARTICIPANTS_REACHED,
                f"{event.name} is happening!",
                f"The minimum of {event.min_participants} participants has been reached.",
                data={"event_id": event_id},
                event_id=event_id,
            )
    reminder_service.schedule_event_reminder(db, event, principal.user_id, principal.guest_id)
    _broadcast(db, event)
    db.commit()
    db.refresh(event)
    return rsvp_state(event, True)


def withdraw(db: Session, principal: Principal, event_id: str) -> dict:
    event = get_accessible_event(db, principal, event_id)
    res = db.execute(delete(RSVP).where(RSVP.event_id == event_id, principal.owns(RSVP)))
    if res.rowcount != 1:
        db.rollback()
        raise Conflict("You are not going to this event", code="not_participating")
    db.execute(update(Event).where(Event.id == event_id).values(participant_count=Event.participant_count - 1))

    # Release tasks the person claimed but did not finish, so others can pick them up.
    released = db.scalars(
        select(TaskAssignment.task_id)
        .join(Task, Task.id == TaskAssignment.task_id)
        .where(Task.event_id == event_id, TaskAssignment.completed_at.is_(None), principal.owns(TaskAssignment))
    ).all()
    if released:
        db.execute(delete(TaskAssignment).where(TaskAssignment.task_id.in_(released)))
        db.execute(update(Task).where(Task.id.in_(released)).values(status=TaskStatus.OPEN, updated_at=utcnow()))
    db.execute(delete(Reminder).where(Reminder.event_id == event_id, Reminder.sent_at.is_(None), principal.owns(Reminder)))

    db.refresh(event)
    if event.participant_count < event.min_participants and event.min_reached_at is not None:
        event.min_reached_at = None
    _broadcast(db, event)
    if released:
        emit_to_groups(db, event_group_ids(db, event_id), {"type": "task.changed", "event_id": event_id, "task_ids": list(released)})
    db.commit()
    return rsvp_state(event, False)


def my_state(db: Session, principal: Principal, event_id: str) -> dict:
    event = get_accessible_event(db, principal, event_id)
    return rsvp_state(event, is_participant(db, principal, event_id))
