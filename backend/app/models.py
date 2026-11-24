"""Database models.

Identity model
--------------
Two kinds of people use the app:

* ``User``  - registered account (email + password). Can create groups and events.
* ``Guest`` - invited by email, no password. Can only see groups they were invited to,
  chat, RSVP and claim tasks. A guest can later upgrade to a ``User``; every row that
  belongs to the guest is then re-pointed to the new user (see ``ACTOR_MODELS``).

Every table that records "who" uses the same pair of columns - ``user_id`` and
``guest_id`` - with a CHECK constraint that exactly one of them is set (``ActorMixin``).

Primary keys are random UUID strings so ids cannot be guessed or enumerated. Messages
use an integer id because unread tracking relies on ordering.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, declared_attr, mapped_column, relationship

from app.db import Base, UTCDateTime, utcnow


def new_id() -> str:
    return str(uuid.uuid4())


EXACTLY_ONE_ACTOR = "(user_id IS NOT NULL AND guest_id IS NULL) OR (user_id IS NULL AND guest_id IS NOT NULL)"
AT_MOST_ONE_ACTOR = "NOT (user_id IS NOT NULL AND guest_id IS NOT NULL)"


class ActorMixin:
    """Adds ``user_id`` / ``guest_id`` columns identifying a user or a guest."""

    @declared_attr
    def user_id(cls) -> Mapped[str | None]:
        return mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True)

    @declared_attr
    def guest_id(cls) -> Mapped[str | None]:
        return mapped_column(ForeignKey("guests.id", ondelete="CASCADE"), index=True, nullable=True)


# --------------------------------------------------------------------------- people


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Guest(Base):
    __tablename__ = "guests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    # Set once the guest upgrades; the guest row is kept as an audit trail but can no longer sign in.
    upgraded_to_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    upgraded_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class AuthSession(ActorMixin, Base):
    """Opaque bearer-token session. Only a SHA-256 hash of the token is stored."""

    __tablename__ = "auth_sessions"
    __table_args__ = (CheckConstraint(EXACTLY_ONE_ACTOR, name="ck_session_actor"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    last_used_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class GuestMagicLink(Base):
    """One-time sign-in link emailed to a guest who lost their session."""

    __tablename__ = "guest_magic_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    guest_id: Mapped[str] = mapped_column(ForeignKey("guests.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


# --------------------------------------------------------------------------- groups


class Group(Base):
    __tablename__ = "groups"
    __table_args__ = (
        CheckConstraint("latitude IS NULL OR (latitude >= -90 AND latitude <= 90)", name="ck_group_lat"),
        CheckConstraint("longitude IS NULL OR (longitude >= -180 AND longitude <= 180)", name="ck_group_lng"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(String(1000))
    image_url: Mapped[str | None] = mapped_column(String(1000))
    location_name: Mapped[str | None] = mapped_column(String(255))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    place_id: Mapped[str | None] = mapped_column(String(255))
    created_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    memberships: Mapped[list["GroupMembership"]] = relationship(back_populates="group", cascade="all, delete-orphan", passive_deletes=True)


class GroupRole:
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    ALL = (OWNER, ADMIN, MEMBER)


class GroupMembership(ActorMixin, Base):
    __tablename__ = "group_memberships"
    __table_args__ = (
        CheckConstraint(EXACTLY_ONE_ACTOR, name="ck_membership_actor"),
        CheckConstraint("role IN ('owner','admin','member')", name="ck_membership_role"),
        UniqueConstraint("group_id", "user_id", name="uq_membership_user"),
        UniqueConstraint("group_id", "guest_id", name="uq_membership_guest"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(10), default=GroupRole.MEMBER)
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    # Unread tracking: highest message id this member has read in the group.
    last_read_message_id: Mapped[int] = mapped_column(Integer, default=0)

    group: Mapped[Group] = relationship(back_populates="memberships")
    user: Mapped["User | None"] = relationship()
    guest: Mapped["Guest | None"] = relationship()


class Invitation(Base):
    """Email invitation to a group. The token is emailed; only its hash is stored."""

    __tablename__ = "invitations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    invited_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    group: Mapped[Group] = relationship()


# --------------------------------------------------------------------------- messaging


class MessageKind:
    TEXT = "text"
    EVENT = "event"  # interactive event card
    EVENT_EXPIRED = "event_expired"  # event card whose event has been deleted
    SYSTEM = "system"


class Message(ActorMixin, Base):
    """A group chat message. ``user_id``/``guest_id`` is the sender (both NULL for system messages)."""

    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint(AT_MOST_ONE_ACTOR, name="ck_message_actor"),
        CheckConstraint("kind IN ('text','event','event_expired','system')", name="ck_message_kind"),
        Index("ix_messages_group_id_id", "group_id", "id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(20), default=MessageKind.TEXT)
    body: Mapped[str] = mapped_column(Text, default="")
    event_id: Mapped[str | None] = mapped_column(ForeignKey("events.id", ondelete="SET NULL"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    user: Mapped["User | None"] = relationship()
    guest: Mapped["Guest | None"] = relationship()


# --------------------------------------------------------------------------- events


class EventStatus:
    ACTIVE = "active"
    CANCELLED = "cancelled"


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint("min_participants >= 1", name="ck_event_min"),
        CheckConstraint("max_participants IS NULL OR max_participants >= min_participants", name="ck_event_max"),
        CheckConstraint("participant_count >= 0", name="ck_event_count_nonneg"),
        CheckConstraint("max_participants IS NULL OR participant_count <= max_participants", name="ck_event_count_max"),
        CheckConstraint("ends_at IS NULL OR ends_at > starts_at", name="ck_event_times"),
        CheckConstraint("status IN ('active','cancelled')", name="ck_event_status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    creator_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    location_name: Mapped[str | None] = mapped_column(String(255))
    address: Mapped[str | None] = mapped_column(String(500))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    place_id: Mapped[str | None] = mapped_column(String(255))
    starts_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    ends_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    min_participants: Mapped[int] = mapped_column(Integer, default=1)
    max_participants: Mapped[int | None] = mapped_column(Integer)
    # Denormalised and updated atomically with every RSVP change (see services/rsvps.py).
    participant_count: Mapped[int] = mapped_column(Integer, default=0)
    min_reached_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    status: Mapped[str] = mapped_column(String(10), default=EventStatus.ACTIVE)
    # When this event is automatically deleted (ends_at or starts_at+default duration, plus grace).
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    creator: Mapped[User] = relationship()
    event_groups: Mapped[list["EventGroup"]] = relationship(back_populates="event", cascade="all, delete-orphan", passive_deletes=True)
    tasks: Mapped[list["Task"]] = relationship(back_populates="event", cascade="all, delete-orphan", passive_deletes=True)


class EventGroup(Base):
    """An event shared to a group. One event can be shared to many groups but has ONE set of
    RSVPs and tasks. ``pinned`` drives the group's list of upcoming pinned events."""

    __tablename__ = "event_groups"
    __table_args__ = (UniqueConstraint("event_id", "group_id", name="uq_event_group"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[str] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    pinned: Mapped[bool] = mapped_column(Boolean, default=True)
    message_id: Mapped[int | None] = mapped_column(ForeignKey("messages.id", ondelete="SET NULL"))
    shared_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    event: Mapped[Event] = relationship(back_populates="event_groups")
    group: Mapped[Group] = relationship()


class RSVP(ActorMixin, Base):
    __tablename__ = "rsvps"
    __table_args__ = (
        CheckConstraint(EXACTLY_ONE_ACTOR, name="ck_rsvp_actor"),
        UniqueConstraint("event_id", "user_id", name="uq_rsvp_user"),
        UniqueConstraint("event_id", "guest_id", name="uq_rsvp_guest"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)

    user: Mapped["User | None"] = relationship()
    guest: Mapped["Guest | None"] = relationship()


# --------------------------------------------------------------------------- tasks


class TaskStatus:
    OPEN = "open"
    CLAIMED = "claimed"
    COMPLETED = "completed"


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (CheckConstraint("status IN ('open','claimed','completed')", name="ck_task_status"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(String(2000))
    status: Mapped[str] = mapped_column(String(10), default=TaskStatus.OPEN)
    created_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)

    event: Mapped[Event] = relationship(back_populates="tasks")
    assignment: Mapped["TaskAssignment | None"] = relationship(back_populates="task", uselist=False, cascade="all, delete-orphan", passive_deletes=True)


class TaskAssignment(ActorMixin, Base):
    """Who claimed a task. ``task_id`` is unique, so a task can never have two assignees."""

    __tablename__ = "task_assignments"
    __table_args__ = (CheckConstraint(EXACTLY_ONE_ACTOR, name="ck_assignment_actor"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), unique=True)
    claimed_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    task: Mapped[Task] = relationship(back_populates="assignment")
    user: Mapped["User | None"] = relationship()
    guest: Mapped["Guest | None"] = relationship()


# --------------------------------------------------------------------------- notifications


class NotificationKind:
    GROUP_INVITE = "group_invite"
    NEW_EVENT = "new_event"
    EVENT_REMINDER = "event_reminder"
    TASK_REMINDER = "task_reminder"
    EVENT_UPDATED = "event_updated"
    EVENT_CANCELLED = "event_cancelled"
    SMART_REMINDER = "smart_reminder"
    MIN_PARTICIPANTS_REACHED = "min_participants_reached"


class Notification(ActorMixin, Base):
    """In-app notification for one recipient (also pushed to the notification API)."""

    __tablename__ = "notifications"
    __table_args__ = (
        CheckConstraint(EXACTLY_ONE_ACTOR, name="ck_notification_actor"),
        Index("ix_notifications_recipient", "user_id", "guest_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(String(1000), default="")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    group_id: Mapped[str | None] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    # Deleting an event removes its notifications so expired event data cannot leak through them.
    event_id: Mapped[str | None] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    pushed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class NotificationPreference(ActorMixin, Base):
    __tablename__ = "notification_preferences"
    __table_args__ = (
        CheckConstraint(EXACTLY_ONE_ACTOR, name="ck_pref_actor"),
        UniqueConstraint("user_id", name="uq_pref_user"),
        UniqueConstraint("guest_id", name="uq_pref_guest"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    group_invites: Mapped[bool] = mapped_column(Boolean, default=True)
    new_events: Mapped[bool] = mapped_column(Boolean, default=True)
    event_reminders: Mapped[bool] = mapped_column(Boolean, default=True)
    task_reminders: Mapped[bool] = mapped_column(Boolean, default=True)
    event_updates: Mapped[bool] = mapped_column(Boolean, default=True)
    smart_reminders: Mapped[bool] = mapped_column(Boolean, default=True)
    push_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    email_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Hours before an event to send the standard upcoming-event reminder.
    reminder_lead_hours: Mapped[int] = mapped_column(Integer, default=24)


class Reminder(ActorMixin, Base):
    """A scheduled reminder for one recipient. ``dedupe_key`` stops the same reminder
    being created twice. Deleted with its event; cancelled when the event is cancelled."""

    __tablename__ = "reminders"
    __table_args__ = (
        CheckConstraint(EXACTLY_ONE_ACTOR, name="ck_reminder_actor"),
        UniqueConstraint("dedupe_key", name="uq_reminder_dedupe"),
        Index("ix_reminders_due", "sent_at", "cancelled_at", "due_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    dedupe_key: Mapped[str] = mapped_column(String(255))
    due_at: Mapped[datetime] = mapped_column(UTCDateTime)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(String(1000), default="")
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


# Every model carrying a (user_id, guest_id) pair; used when a guest upgrades.
ACTOR_MODELS = [
    GroupMembership,
    Message,
    RSVP,
    TaskAssignment,
    Notification,
    NotificationPreference,
    Reminder,
]
