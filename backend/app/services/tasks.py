"""Event tasks. Claiming uses a conditional UPDATE (``WHERE status = 'open'``) so two
participants can never both claim the same task; ``task_assignments.task_id`` is unique
as a second line of defence."""
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.db import utcnow
from app.errors import Conflict, Forbidden, NotFound
from app.models import Event, EventStatus, Task, TaskAssignment, TaskStatus
from app.security import Principal
from app.services.access import can_access_event_condition, get_accessible_event, is_participant, require_event_creator
from app.services.events import event_group_ids
from app.services.messages import actor_out
from app.services.runtime import emit_to_groups


def task_out(task: Task) -> dict:
    a = task.assignment
    return {
        "id": task.id,
        "event_id": task.event_id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "assignee": actor_out(a.user, a.guest) if a else None,
        "claimed_at": a.claimed_at if a else None,
        "completed_at": a.completed_at if a else None,
        "created_at": task.created_at,
    }


def _load(db: Session, task_id: str) -> Task:
    db.expire_all()
    return db.scalar(
        select(Task)
        .options(selectinload(Task.assignment).selectinload(TaskAssignment.user), selectinload(Task.assignment).selectinload(TaskAssignment.guest))
        .where(Task.id == task_id)
    )


def _get_task(db: Session, principal: Principal, event_id: str, task_id: str) -> tuple[Event, Task]:
    event = get_accessible_event(db, principal, event_id)
    task = db.scalar(select(Task).where(Task.id == task_id, Task.event_id == event_id))
    if task is None:
        raise NotFound("Task not found")
    return event, task


def _active(event: Event) -> None:
    if event.status != EventStatus.ACTIVE:
        raise Conflict("This event was cancelled", code="event_cancelled")


def _changed(db: Session, event_id: str, task_ids: list[str]) -> None:
    emit_to_groups(db, event_group_ids(db, event_id), {"type": "task.changed", "event_id": event_id, "task_ids": task_ids})


def list_tasks(db: Session, principal: Principal, event_id: str) -> list[dict]:
    get_accessible_event(db, principal, event_id)
    tasks = db.scalars(
        select(Task)
        .options(selectinload(Task.assignment).selectinload(TaskAssignment.user), selectinload(Task.assignment).selectinload(TaskAssignment.guest))
        .where(Task.event_id == event_id)
        .order_by(Task.created_at)
    )
    return [task_out(t) for t in tasks]


def create_task(db: Session, principal: Principal, event_id: str, data) -> dict:
    event = require_event_creator(db, principal, event_id)
    _active(event)
    task = Task(event_id=event_id, title=data.title, description=data.description, created_by_user_id=principal.id)
    db.add(task)
    db.flush()
    _changed(db, event_id, [task.id])
    db.commit()
    return task_out(_load(db, task.id))


def update_task(db: Session, principal: Principal, event_id: str, task_id: str, data) -> dict:
    require_event_creator(db, principal, event_id)
    _, task = _get_task(db, principal, event_id, task_id)
    for k, v in data.model_dump(exclude_unset=True).items():
        if k == "title" and not v:
            continue
        setattr(task, k, v)
    _changed(db, event_id, [task_id])
    db.commit()
    return task_out(_load(db, task_id))


def delete_task(db: Session, principal: Principal, event_id: str, task_id: str) -> None:
    require_event_creator(db, principal, event_id)
    _, task = _get_task(db, principal, event_id, task_id)
    db.delete(task)
    _changed(db, event_id, [task_id])
    db.commit()


def claim(db: Session, principal: Principal, event_id: str, task_id: str) -> dict:
    event, _ = _get_task(db, principal, event_id, task_id)
    _active(event)
    if not is_participant(db, principal, event_id):
        raise Forbidden("Join the event before claiming tasks", code="not_participating")
    res = db.execute(
        update(Task).where(Task.id == task_id, Task.status == TaskStatus.OPEN).values(status=TaskStatus.CLAIMED, updated_at=utcnow())
    )
    if res.rowcount != 1:
        db.rollback()
        raise Conflict("Someone has already claimed this task", code="task_already_claimed")
    try:
        db.add(TaskAssignment(task_id=task_id, **principal.actor_values()))
        db.flush()
    except IntegrityError:
        db.rollback()
        raise Conflict("Someone has already claimed this task", code="task_already_claimed")
    _changed(db, event_id, [task_id])
    db.commit()
    return task_out(_load(db, task_id))


def _my_assignment(db: Session, principal: Principal, task_id: str) -> TaskAssignment | None:
    return db.scalar(select(TaskAssignment).where(TaskAssignment.task_id == task_id, principal.owns(TaskAssignment)))


def unclaim(db: Session, principal: Principal, event_id: str, task_id: str) -> dict:
    event, task = _get_task(db, principal, event_id, task_id)
    is_creator = principal.is_user and principal.id == event.creator_user_id
    if _my_assignment(db, principal, task_id) is None and not is_creator:
        raise Forbidden("You have not claimed this task")
    res = db.execute(
        update(Task).where(Task.id == task_id, Task.status == TaskStatus.CLAIMED).values(status=TaskStatus.OPEN, updated_at=utcnow())
    )
    if res.rowcount != 1:
        db.rollback()
        raise Conflict("Only claimed, unfinished tasks can be unclaimed", code="task_not_claimed")
    db.execute(delete(TaskAssignment).where(TaskAssignment.task_id == task_id))
    _changed(db, event_id, [task_id])
    db.commit()
    return task_out(_load(db, task_id))


def complete(db: Session, principal: Principal, event_id: str, task_id: str) -> dict:
    event, task = _get_task(db, principal, event_id, task_id)
    _active(event)
    assignment = _my_assignment(db, principal, task_id)
    if assignment is None:
        raise Forbidden("Claim this task before completing it")
    res = db.execute(
        update(Task).where(Task.id == task_id, Task.status == TaskStatus.CLAIMED).values(status=TaskStatus.COMPLETED, updated_at=utcnow())
    )
    if res.rowcount != 1:
        db.rollback()
        raise Conflict("This task is already completed", code="task_already_completed")
    assignment.completed_at = utcnow()
    _changed(db, event_id, [task_id])
    db.commit()
    return task_out(_load(db, task_id))


def outstanding_for(db: Session, principal: Principal) -> list[dict]:
    """Tasks the caller has claimed but not completed, on events that still exist."""
    rows = db.execute(
        select(Task, Event)
        .join(TaskAssignment, TaskAssignment.task_id == Task.id)
        .join(Event, Event.id == Task.event_id)
        .options(selectinload(Task.assignment).selectinload(TaskAssignment.user), selectinload(Task.assignment).selectinload(TaskAssignment.guest))
        .where(
            principal.owns(TaskAssignment),
            TaskAssignment.completed_at.is_(None),
            Event.status == EventStatus.ACTIVE,
            Event.expires_at > utcnow(),
            can_access_event_condition(principal),
        )
        .order_by(Event.starts_at)
    ).all()
    return [{**task_out(t), "event_name": e.name, "event_starts_at": e.starts_at} for t, e in rows]
