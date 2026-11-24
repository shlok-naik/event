"""Request/response types shared with the frontend (also exported to docs/openapi.json)."""
from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

Name = Field(min_length=1, max_length=100)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- common


class Coordinates(StrictModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class LocationIn(StrictModel):
    """A place. ``latitude``/``longitude`` must be given together."""

    name: str | None = Field(default=None, max_length=255)
    address: str | None = Field(default=None, max_length=500)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    place_id: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def _pair(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("latitude and longitude must be provided together")
        return self


class Location(BaseModel):
    name: str | None = None
    address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    place_id: str | None = None


class ActorOut(BaseModel):
    type: Literal["user", "guest"]
    id: str
    display_name: str


class OkOut(BaseModel):
    ok: bool = True


# --------------------------------------------------------------------------- auth


class RegisterIn(StrictModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    display_name: str = Field(min_length=1, max_length=80)


class LoginIn(StrictModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class MeOut(BaseModel):
    type: Literal["user", "guest"]
    id: str
    email: str
    display_name: str


class SessionOut(BaseModel):
    token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in_days: int
    principal: MeOut


class UpdateMeIn(StrictModel):
    display_name: str = Field(min_length=1, max_length=80)


class GuestUpgradeIn(StrictModel):
    password: str = Field(min_length=8, max_length=256)
    display_name: str | None = Field(default=None, min_length=1, max_length=80)


class MagicLinkRequestIn(StrictModel):
    email: EmailStr


class TokenIn(StrictModel):
    token: str = Field(min_length=10, max_length=200)


class AcceptInvitationIn(StrictModel):
    token: str = Field(min_length=10, max_length=200)
    display_name: str | None = Field(default=None, min_length=1, max_length=80)


class InvitationPreviewOut(BaseModel):
    group_name: str
    email: str
    invited_by: str | None
    expires_at: datetime
    requires_login: bool  # True when the email belongs to a registered account


class AcceptInvitationOut(BaseModel):
    group_id: str
    session: SessionOut | None = None  # issued for guests (and not for logged-in users)


# --------------------------------------------------------------------------- groups


class GroupCreateIn(StrictModel):
    name: str = Name
    description: str | None = Field(default=None, max_length=1000)
    image_url: str | None = Field(default=None, max_length=1000)
    location: LocationIn | None = None

    @field_validator("image_url")
    @classmethod
    def _https(cls, v):
        if v and not (v.startswith("https://") or v.startswith("/media/")):
            raise ValueError("image_url must be an https:// URL")
        return v


class GroupUpdateIn(GroupCreateIn):
    name: str | None = Field(default=None, min_length=1, max_length=100)


class GroupOut(BaseModel):
    id: str
    name: str
    description: str | None
    image_url: str | None
    location: Location | None
    my_role: str
    member_count: int
    unread_count: int
    last_message_at: datetime | None
    created_at: datetime


class GroupLocationOut(BaseModel):
    group_id: str
    name: str
    location: Location


class MemberOut(BaseModel):
    membership_id: str
    actor: ActorOut
    role: str
    joined_at: datetime
    email: str | None = None  # only visible to group owners/admins


class RoleUpdateIn(StrictModel):
    role: Literal["admin", "member", "owner"]


class InviteIn(StrictModel):
    emails: list[EmailStr] = Field(min_length=1, max_length=50)


class InvitationOut(ORMModel):
    id: str
    email: str
    created_at: datetime
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None


class InviteResultOut(BaseModel):
    invited: list[InvitationOut]
    already_members: list[str]


# --------------------------------------------------------------------------- messages


class MessageCreateIn(StrictModel):
    body: str = Field(min_length=1, max_length=4000)


class EventSummary(BaseModel):
    id: str
    name: str
    starts_at: datetime
    ends_at: datetime | None
    location: Location | None
    status: str
    participant_count: int
    min_participants: int
    max_participants: int | None
    min_reached: bool
    is_full: bool
    my_rsvp: bool


class MessageOut(BaseModel):
    id: int
    group_id: str
    kind: Literal["text", "event", "event_expired", "system"]
    body: str
    sender: ActorOut | None
    created_at: datetime
    event: EventSummary | None = None  # present for kind == "event"


class MessagePageOut(BaseModel):
    messages: list[MessageOut]  # newest last
    has_more: bool


class MarkReadIn(StrictModel):
    message_id: int = Field(ge=0)


class UnreadOut(BaseModel):
    group_id: str
    unread_count: int


# --------------------------------------------------------------------------- events


class EventBase(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=5000)
    location: LocationIn | None = None
    starts_at: AwareDatetime
    ends_at: AwareDatetime | None = None
    min_participants: int = Field(default=1, ge=1, le=10000)
    max_participants: int | None = Field(default=None, ge=1, le=10000)

    @model_validator(mode="after")
    def _check(self):
        if self.ends_at is not None and self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        if self.max_participants is not None and self.max_participants < self.min_participants:
            raise ValueError("max_participants must be >= min_participants")
        return self


class EventCreateIn(EventBase):
    group_ids: list[str] = Field(min_length=1, max_length=20)


class EventUpdateIn(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=5000)
    location: LocationIn | None = None
    starts_at: AwareDatetime | None = None
    ends_at: AwareDatetime | None = None
    min_participants: int | None = Field(default=None, ge=1, le=10000)
    max_participants: int | None = Field(default=None, ge=1, le=10000)


class ShareEventIn(StrictModel):
    group_ids: list[str] = Field(min_length=1, max_length=20)


class EventOut(EventSummary):
    description: str | None
    creator: ActorOut
    group_ids: list[str]  # only the groups the caller is a member of
    is_creator: bool
    created_at: datetime
    updated_at: datetime
    task_counts: dict[str, int]


class ParticipantOut(BaseModel):
    actor: ActorOut
    rsvp_at: datetime


class RSVPStateOut(BaseModel):
    event_id: str
    participating: bool
    participant_count: int
    min_participants: int
    max_participants: int | None
    min_reached: bool
    is_full: bool


# --------------------------------------------------------------------------- tasks


class TaskCreateIn(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class TaskUpdateIn(StrictModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class TaskOut(BaseModel):
    id: str
    event_id: str
    title: str
    description: str | None
    status: Literal["open", "claimed", "completed"]
    assignee: ActorOut | None
    claimed_at: datetime | None
    completed_at: datetime | None
    created_at: datetime


class OutstandingTaskOut(TaskOut):
    event_name: str
    event_starts_at: datetime


# --------------------------------------------------------------------------- notifications


class NotificationOut(ORMModel):
    id: str
    kind: str
    title: str
    body: str
    data: dict
    group_id: str | None
    event_id: str | None
    created_at: datetime
    read_at: datetime | None


class NotificationPreferencesOut(ORMModel):
    group_invites: bool
    new_events: bool
    event_reminders: bool
    task_reminders: bool
    event_updates: bool
    smart_reminders: bool
    push_enabled: bool
    email_enabled: bool
    reminder_lead_hours: int


class NotificationPreferencesIn(StrictModel):
    group_invites: bool | None = None
    new_events: bool | None = None
    event_reminders: bool | None = None
    task_reminders: bool | None = None
    event_updates: bool | None = None
    smart_reminders: bool | None = None
    push_enabled: bool | None = None
    email_enabled: bool | None = None
    reminder_lead_hours: int | None = Field(default=None, ge=1, le=168)


class MarkNotificationsReadIn(StrictModel):
    ids: list[str] | None = Field(default=None, max_length=200)  # None = all


# --------------------------------------------------------------------------- locations


class PlaceOut(BaseModel):
    place_id: str | None
    name: str | None
    address: str | None
    latitude: float | None
    longitude: float | None
