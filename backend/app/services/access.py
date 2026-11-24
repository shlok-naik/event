"""Central permission checks.

Rules:
* A group, its messages, members and location are visible only to its members.
* An event is visible only to members of at least one group it was shared to.
* An event past its ``expires_at`` is treated as gone even before the cleanup job deletes it.
* Lookups a caller is not allowed to see return 404 (not 403) so ids cannot be probed.
"""
from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.errors import Forbidden, NotFound
from app.models import RSVP, Event, EventGroup, Group, GroupMembership, GroupRole
from app.security import Principal


def get_membership(db: Session, principal: Principal, group_id: str) -> GroupMembership | None:
    return db.scalar(
        select(GroupMembership).where(GroupMembership.group_id == group_id, principal.owns(GroupMembership))
    )


def require_member(db: Session, principal: Principal, group_id: str) -> GroupMembership:
    m = get_membership(db, principal, group_id)
    if m is None:
        raise NotFound("Group not found")
    return m


def require_group_admin(db: Session, principal: Principal, group_id: str) -> GroupMembership:
    m = require_member(db, principal, group_id)
    if m.role not in (GroupRole.OWNER, GroupRole.ADMIN):
        raise Forbidden("Only group owners and admins can do this")
    return m


def require_group(db: Session, principal: Principal, group_id: str) -> tuple[Group, GroupMembership]:
    m = require_member(db, principal, group_id)
    return m.group, m


def member_group_ids(principal: Principal):
    """Subquery of group ids the principal belongs to."""
    return select(GroupMembership.group_id).where(principal.owns(GroupMembership))


def can_access_event_condition(principal: Principal):
    return exists().where(
        EventGroup.event_id == Event.id,
        EventGroup.group_id.in_(member_group_ids(principal)),
    )


def get_accessible_event(db: Session, principal: Principal, event_id: str, *, lock: bool = False) -> Event:
    q = select(Event).where(Event.id == event_id, Event.expires_at > utcnow(), can_access_event_condition(principal))
    if lock:
        q = q.with_for_update()
    event = db.scalar(q)
    if event is None:
        raise NotFound("Event not found")
    return event


def require_event_creator(db: Session, principal: Principal, event_id: str) -> Event:
    event = get_accessible_event(db, principal, event_id)
    if not principal.is_user or event.creator_user_id != principal.id:
        raise Forbidden("Only the event creator can do this")
    return event


def is_participant(db: Session, principal: Principal, event_id: str) -> bool:
    return db.scalar(select(exists().where(RSVP.event_id == event_id, principal.owns(RSVP)))) or False
