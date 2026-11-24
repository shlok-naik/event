"""Groups, memberships, invitations and group locations."""
import secrets
from datetime import timedelta
from pathlib import Path

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from app.db import utcnow
from app.errors import BadRequest, Conflict, Forbidden, NotFound, Unauthorized
from app.models import (
    EventGroup,
    Group,
    GroupMembership,
    GroupRole,
    Guest,
    Invitation,
    Message,
    NotificationKind,
    User,
)
from app.security import Principal, create_session, hash_token, new_token, principal_from_guest
from app.services import messages as msg_service
from app.services.access import member_group_ids, require_group_admin, require_member
from app.services.auth import active_guest_by_email, normalize_email
from app.services.delivery import actor_key
from app.services.notifications import notify
from app.services.runtime import emit, emit_to_groups, rt

# --------------------------------------------------------------------------- groups


def _apply_location(group: Group, loc) -> None:
    if loc is None:
        return
    group.location_name = loc.name
    group.latitude = loc.latitude
    group.longitude = loc.longitude
    group.place_id = loc.place_id


def create_group(db: Session, principal: Principal, data) -> Group:
    principal.require_user()
    group = Group(name=data.name, description=data.description, image_url=data.image_url, created_by_user_id=principal.id)
    _apply_location(group, data.location)
    db.add(group)
    db.flush()
    db.add(GroupMembership(group_id=group.id, role=GroupRole.OWNER, **principal.actor_values()))
    db.commit()
    return group


def update_group(db: Session, principal: Principal, group_id: str, data) -> Group:
    m = require_group_admin(db, principal, group_id)
    group = m.group
    fields = data.model_dump(exclude_unset=True)
    for key in ("name", "description", "image_url"):
        if key in fields:
            if key == "name" and not fields[key]:
                raise BadRequest("name cannot be empty")
            setattr(group, key, fields[key])
    if "location" in fields:
        if data.location is None:
            group.location_name = group.latitude = group.longitude = group.place_id = None
        else:
            _apply_location(group, data.location)
    emit_to_groups(db, [group_id], {"type": "group.updated", "group_id": group_id})
    db.commit()
    return group


def delete_group(db: Session, principal: Principal, group_id: str) -> None:
    m = require_member(db, principal, group_id)
    if m.role != GroupRole.OWNER:
        raise Forbidden("Only the group owner can delete the group")
    emit_to_groups(db, [group_id], {"type": "group.deleted", "group_id": group_id})
    # Events shared ONLY to this group would become unreachable: delete them as well.
    from app.services.cleanup import delete_events

    sole = db.scalars(
        select(EventGroup.event_id)
        .group_by(EventGroup.event_id)
        .having(func.count(EventGroup.id) == 1)
        .where(EventGroup.event_id.in_(select(EventGroup.event_id).where(EventGroup.group_id == group_id)))
    ).all()
    delete_events(db, list(sole), notify_members=False)
    db.delete(m.group)
    db.commit()


ALLOWED_IMAGE_TYPES = {b"\x89PNG\r\n\x1a\n": ".png", b"\xff\xd8\xff": ".jpg", b"RIFF": ".webp", b"GIF8": ".gif"}


def save_group_image(db: Session, principal: Principal, group_id: str, content: bytes) -> Group:
    m = require_group_admin(db, principal, group_id)
    settings = rt().settings
    if len(content) > settings.max_image_bytes:
        raise BadRequest(f"Image must be at most {settings.max_image_bytes // 1024} KB")
    ext = next((e for magic, e in ALLOWED_IMAGE_TYPES.items() if content.startswith(magic)), None)
    if ext == ".webp" and content[8:12] != b"WEBP":
        ext = None
    if ext is None:
        raise BadRequest("Image must be PNG, JPEG, GIF or WebP")
    media = Path(settings.media_dir) / "groups"
    media.mkdir(parents=True, exist_ok=True)
    name = f"{group_id}-{secrets.token_hex(8)}{ext}"
    (media / name).write_bytes(content)
    m.group.image_url = f"/media/groups/{name}"
    db.commit()
    return m.group


def list_groups(db: Session, principal: Principal) -> list[dict]:
    memberships = db.scalars(
        select(GroupMembership).options(selectinload(GroupMembership.group)).where(principal.owns(GroupMembership))
    ).all()
    gids = [m.group_id for m in memberships]
    counts = dict(
        db.execute(select(GroupMembership.group_id, func.count()).where(GroupMembership.group_id.in_(gids)).group_by(GroupMembership.group_id)).all()
    )
    last = msg_service.group_last_message_at(db, gids)
    out = [group_out(db, principal, m, counts.get(m.group_id, 0), last.get(m.group_id)) for m in memberships]
    out.sort(key=lambda g: g["last_message_at"] or g["created_at"], reverse=True)
    return out


def get_group(db: Session, principal: Principal, group_id: str) -> dict:
    m = require_member(db, principal, group_id)
    count = db.scalar(select(func.count()).where(GroupMembership.group_id == group_id))
    last = msg_service.group_last_message_at(db, [group_id]).get(group_id)
    return group_out(db, principal, m, count, last)


def group_out(db: Session, principal: Principal, m: GroupMembership, member_count: int, last_message_at) -> dict:
    g = m.group
    return {
        "id": g.id,
        "name": g.name,
        "description": g.description,
        "image_url": g.image_url,
        "location": msg_service.location_out(g),
        "my_role": m.role,
        "member_count": member_count,
        "unread_count": msg_service.unread_count(db, principal, g.id, m.last_read_message_id),
        "last_message_at": last_message_at,
        "created_at": g.created_at,
    }


def group_locations(db: Session, principal: Principal) -> list[dict]:
    """Coordinates of the caller's groups only (for the map view)."""
    groups = db.scalars(select(Group).where(Group.id.in_(member_group_ids(principal)), Group.latitude.is_not(None))).all()
    return [{"group_id": g.id, "name": g.name, "location": msg_service.location_out(g)} for g in groups]


# --------------------------------------------------------------------------- members


def list_members(db: Session, principal: Principal, group_id: str) -> list[dict]:
    me = require_member(db, principal, group_id)
    show_email = me.role in (GroupRole.OWNER, GroupRole.ADMIN)
    rows = db.scalars(
        select(GroupMembership)
        .options(selectinload(GroupMembership.user), selectinload(GroupMembership.guest))
        .where(GroupMembership.group_id == group_id)
        .order_by(GroupMembership.joined_at)
    ).all()
    out = []
    for m in rows:
        person = m.user or m.guest
        out.append(
            {
                "membership_id": m.id,
                "actor": msg_service.actor_out(m.user, m.guest),
                "role": m.role,
                "joined_at": m.joined_at,
                "email": person.email if show_email else None,
            }
        )
    return out


def _get_target_membership(db: Session, group_id: str, membership_id: str) -> GroupMembership:
    target = db.scalar(select(GroupMembership).where(GroupMembership.id == membership_id, GroupMembership.group_id == group_id))
    if target is None:
        raise NotFound("Member not found")
    return target


def _owner_count(db: Session, group_id: str) -> int:
    return db.scalar(select(func.count()).where(GroupMembership.group_id == group_id, GroupMembership.role == GroupRole.OWNER))


def change_role(db: Session, principal: Principal, group_id: str, membership_id: str, role: str) -> GroupMembership:
    me = require_member(db, principal, group_id)
    if me.role != GroupRole.OWNER:
        raise Forbidden("Only the group owner can change roles")
    target = _get_target_membership(db, group_id, membership_id)
    if target.guest_id and role != GroupRole.MEMBER:
        raise BadRequest("Guests can only be regular members")
    if target.role == GroupRole.OWNER and role != GroupRole.OWNER and _owner_count(db, group_id) <= 1:
        raise Conflict("A group must keep at least one owner")
    target.role = role
    db.commit()
    return target


def remove_member(db: Session, principal: Principal, group_id: str, membership_id: str) -> None:
    me = require_member(db, principal, group_id)
    target = _get_target_membership(db, group_id, membership_id)
    is_self = target.id == me.id
    if not is_self:
        if me.role not in (GroupRole.OWNER, GroupRole.ADMIN):
            raise Forbidden("Only owners and admins can remove members")
        if target.role == GroupRole.OWNER or (target.role == GroupRole.ADMIN and me.role != GroupRole.OWNER):
            raise Forbidden("You cannot remove this member")
    if target.role == GroupRole.OWNER and _owner_count(db, group_id) <= 1:
        raise Conflict("Transfer ownership before leaving, or delete the group")
    person = target.user or target.guest
    key = actor_key(target.user_id, target.guest_id)
    db.delete(target)
    msg_service.post_system_message(db, group_id, f"{person.display_name} {'left' if is_self else 'was removed from'} the group")
    emit(db, {key}, {"type": "group.removed", "group_id": group_id})
    db.commit()


# --------------------------------------------------------------------------- invitations


def invite(db: Session, principal: Principal, group_id: str, emails: list[str]) -> dict:
    principal.require_user()
    m = require_member(db, principal, group_id)
    group = m.group
    settings = rt().settings
    now = utcnow()
    emails = list(dict.fromkeys(normalize_email(e) for e in emails))

    member_emails = set(
        db.scalars(select(User.email).join(GroupMembership, GroupMembership.user_id == User.id).where(GroupMembership.group_id == group_id))
    ) | set(db.scalars(select(Guest.email).join(GroupMembership, GroupMembership.guest_id == Guest.id).where(GroupMembership.group_id == group_id)))

    invited, already, outgoing = [], [], []
    for email in emails:
        if email in member_emails:
            already.append(email)
            continue
        # A newer invitation replaces older pending ones for the same address.
        db.execute(
            update(Invitation)
            .where(Invitation.group_id == group_id, Invitation.email == email, Invitation.accepted_at.is_(None), Invitation.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        token = new_token()
        inv = Invitation(
            group_id=group_id,
            email=email,
            token_hash=hash_token(token),
            invited_by_user_id=principal.id,
            created_at=now,
            expires_at=now + timedelta(days=settings.invitation_ttl_days),
        )
        db.add(inv)
        db.flush()
        invited.append(inv)
        outgoing.append((email, token))

        # Existing users/guests also get an in-app notification (accept via /invitations/{id}/accept).
        user = db.scalar(select(User).where(User.email == email))
        guest = None if user else active_guest_by_email(db, email)
        if user or guest:
            notify(
                db,
                [(user.id if user else None, guest.id if guest else None)],
                NotificationKind.GROUP_INVITE,
                f"{principal.display_name} invited you to {group.name}",
                data={"invitation_id": inv.id, "group_name": group.name},
            )
    db.commit()

    for email, token in outgoing:
        link = f"{settings.frontend_base_url}/invite?token={token}"
        rt().email.send(
            email,
            f"You're invited to join {group.name}",
            f"{principal.display_name} invited you to the group \"{group.name}\".\n\n"
            f"Join here (no account needed): {link}\n\nThis invitation expires in {settings.invitation_ttl_days} days.",
        )
    return {"invited": invited, "already_members": already}


def list_invitations(db: Session, principal: Principal, group_id: str) -> list[Invitation]:
    require_group_admin(db, principal, group_id)
    return db.scalars(
        select(Invitation).where(Invitation.group_id == group_id, Invitation.accepted_at.is_(None), Invitation.revoked_at.is_(None), Invitation.expires_at > utcnow())
    ).all()


def revoke_invitation(db: Session, principal: Principal, group_id: str, invitation_id: str) -> None:
    require_group_admin(db, principal, group_id)
    inv = db.scalar(select(Invitation).where(Invitation.id == invitation_id, Invitation.group_id == group_id))
    if inv is None:
        raise NotFound("Invitation not found")
    inv.revoked_at = utcnow()
    db.commit()


def _pending_invitation_by_token(db: Session, token: str) -> Invitation:
    inv = db.scalar(select(Invitation).where(Invitation.token_hash == hash_token(token)))
    if inv is None or inv.revoked_at or inv.accepted_at or inv.expires_at <= utcnow():
        raise NotFound("This invitation is invalid or has expired", code="invalid_invitation")
    return inv


def preview_invitation(db: Session, token: str) -> dict:
    inv = _pending_invitation_by_token(db, token)
    inviter = db.get(User, inv.invited_by_user_id) if inv.invited_by_user_id else None
    return {
        "group_name": inv.group.name,
        "email": inv.email,
        "invited_by": inviter.display_name if inviter else None,
        "expires_at": inv.expires_at,
        "requires_login": db.scalar(select(User.id).where(User.email == inv.email)) is not None,
    }


def _join(db: Session, inv: Invitation, *, user: User | None = None, guest: Guest | None = None) -> None:
    exists_q = select(GroupMembership).where(GroupMembership.group_id == inv.group_id)
    exists_q = exists_q.where(GroupMembership.user_id == user.id) if user else exists_q.where(GroupMembership.guest_id == guest.id)
    if db.scalar(exists_q) is None:
        db.add(GroupMembership(group_id=inv.group_id, role=GroupRole.MEMBER, user_id=user.id if user else None, guest_id=guest.id if guest else None))
        db.flush()
        msg_service.post_system_message(db, inv.group_id, f"{(user or guest).display_name} joined the group")
        # New members start with no unread backlog (including their own join message).
        latest = db.scalar(select(func.max(Message.id)).where(Message.group_id == inv.group_id)) or 0
        db.execute(
            update(GroupMembership)
            .where(GroupMembership.group_id == inv.group_id, (GroupMembership.user_id == user.id) if user else (GroupMembership.guest_id == guest.id))
            .values(last_read_message_id=latest)
        )
    inv.accepted_at = utcnow()


def accept_invitation_token(db: Session, token: str, principal: Principal | None, display_name: str | None) -> dict:
    """Accept an emailed invitation. Holding the token proves control of the email address.

    * Email belongs to a registered user -> caller must be logged in as that user.
    * Otherwise the caller becomes (or continues as) a guest and receives a guest session.
    """
    inv = _pending_invitation_by_token(db, token)
    user = db.scalar(select(User).where(User.email == inv.email))
    if user is not None:
        if principal is None or not principal.is_user or principal.id != user.id:
            raise Unauthorized("Log in to the account for this email to accept", code="login_required")
        _join(db, inv, user=user)
        db.commit()
        return {"group_id": inv.group_id, "session": None}

    guest = active_guest_by_email(db, inv.email)
    if guest is None:
        guest = Guest(email=inv.email, display_name=display_name or inv.email.split("@")[0][:80])
        db.add(guest)
        db.flush()
    elif display_name:
        guest.display_name = display_name
    _join(db, inv, guest=guest)
    session = None
    if not (principal and principal.is_guest and principal.id == guest.id):
        ttl = rt().settings.guest_session_ttl_days
        session = {"token": create_session(db, guest=guest, ttl_days=ttl), "expires_in_days": ttl, "principal": principal_from_guest(guest)}
    db.commit()
    return {"group_id": inv.group_id, "session": session}


def accept_invitation_in_app(db: Session, principal: Principal, invitation_id: str) -> dict:
    """Accept from the in-app notification: the signed-in account's email must match."""
    inv = db.get(Invitation, invitation_id)
    if inv is None or inv.email != principal.email or inv.revoked_at or inv.accepted_at or inv.expires_at <= utcnow():
        raise NotFound("Invitation not found", code="invalid_invitation")
    if principal.is_user:
        _join(db, inv, user=db.get(User, principal.id))
    else:
        _join(db, inv, guest=db.get(Guest, principal.id))
    db.commit()
    return {"group_id": inv.group_id, "session": None}

