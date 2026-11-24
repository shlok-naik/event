from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from sqlalchemy.orm import Session

from app import schemas as s
from app.deps import current_principal, current_user, get_db, optional_principal
from app.errors import BadRequest
from app.ratelimit import limit
from app.routers.auth import me_out
from app.security import Principal
from app.services import groups as svc
from app.services import messages as msg_svc
from app.services.runtime import rt

router = APIRouter(tags=["groups"])


@router.get("/groups", response_model=list[s.GroupOut])
def list_groups(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Groups the caller belongs to, most recently active first, with unread counts."""
    return svc.list_groups(db, p)


@router.post("/groups", response_model=s.GroupOut, status_code=201)
def create_group(body: s.GroupCreateIn, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    g = svc.create_group(db, p, body)
    return svc.get_group(db, p, g.id)


@router.get("/groups/locations", response_model=list[s.GroupLocationOut])
def group_locations(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Map pins: coordinates of the caller's own groups only."""
    return svc.group_locations(db, p)


@router.get("/groups/{group_id}", response_model=s.GroupOut)
def get_group(group_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return svc.get_group(db, p, group_id)


@router.patch("/groups/{group_id}", response_model=s.GroupOut)
def update_group(group_id: str, body: s.GroupUpdateIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    svc.update_group(db, p, group_id, body)
    return svc.get_group(db, p, group_id)


@router.delete("/groups/{group_id}", status_code=204)
def delete_group(group_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    svc.delete_group(db, p, group_id)
    return Response(status_code=204)


@router.post("/groups/{group_id}/image", response_model=s.GroupOut, dependencies=[Depends(limit("upload", 20, 3600, per="principal"))])
async def upload_group_image(group_id: str, file: UploadFile = File(...), p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    content = await file.read(rt().settings.max_image_bytes + 1)
    if not content:
        raise BadRequest("Empty file")
    svc.save_group_image(db, p, group_id, content)
    return svc.get_group(db, p, group_id)


# --------------------------------------------------------------------------- members


@router.get("/groups/{group_id}/members", response_model=list[s.MemberOut])
def members(group_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Members' display names. Emails are only included for owners/admins."""
    return svc.list_members(db, p, group_id)


@router.patch("/groups/{group_id}/members/{membership_id}", response_model=s.OkOut)
def change_role(group_id: str, membership_id: str, body: s.RoleUpdateIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    svc.change_role(db, p, group_id, membership_id, body.role)
    return {"ok": True}


@router.delete("/groups/{group_id}/members/{membership_id}", status_code=204)
def remove_member(group_id: str, membership_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Remove a member (owner/admin) or leave the group (your own membership id)."""
    svc.remove_member(db, p, group_id, membership_id)
    return Response(status_code=204)


# --------------------------------------------------------------------------- invitations


@router.post("/groups/{group_id}/invitations", response_model=s.InviteResultOut, status_code=201,
             dependencies=[Depends(limit("invite", 30, 3600, per="principal"))])
def invite(group_id: str, body: s.InviteIn, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    """Invite up to 50 email addresses at once. Each receives a secure, single-use link."""
    return svc.invite(db, p, group_id, [str(e) for e in body.emails])


@router.get("/groups/{group_id}/invitations", response_model=list[s.InvitationOut])
def list_invitations(group_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return svc.list_invitations(db, p, group_id)


@router.delete("/groups/{group_id}/invitations/{invitation_id}", status_code=204)
def revoke_invitation(group_id: str, invitation_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    svc.revoke_invitation(db, p, group_id, invitation_id)
    return Response(status_code=204)


@router.post("/invitations/preview", response_model=s.InvitationPreviewOut, tags=["invitations"],
             dependencies=[Depends(limit("invite_token", 30, 60))])
def preview_invitation(body: s.TokenIn, db: Session = Depends(get_db)):
    """What the invite landing page shows before accepting."""
    return svc.preview_invitation(db, body.token)


@router.post("/invitations/accept", response_model=s.AcceptInvitationOut, tags=["invitations"],
             dependencies=[Depends(limit("invite_token", 30, 60))])
def accept_invitation(body: s.AcceptInvitationIn, p: Principal | None = Depends(optional_principal), db: Session = Depends(get_db)):
    """Accept an emailed invitation. Guests get a session back; if the email belongs to a
    registered account the caller must be logged in as it (401 ``login_required``)."""
    result = svc.accept_invitation_token(db, body.token, p, body.display_name)
    if result["session"]:
        sess = result["session"]
        result["session"] = {"token": sess["token"], "expires_in_days": sess["expires_in_days"], "principal": me_out(sess["principal"])}
    return result


@router.post("/invitations/{invitation_id}/accept", response_model=s.AcceptInvitationOut, tags=["invitations"])
def accept_invitation_in_app(invitation_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Accept from an in-app ``group_invite`` notification (email must match the account)."""
    return svc.accept_invitation_in_app(db, p, invitation_id)


# --------------------------------------------------------------------------- messages


@router.get("/groups/{group_id}/messages", response_model=s.MessagePageOut, tags=["messages"])
def message_history(
    group_id: str,
    before_id: int | None = Query(default=None, ge=1),
    limit_: int = Query(default=50, ge=1, le=100, alias="limit"),
    p: Principal = Depends(current_principal),
    db: Session = Depends(get_db),
):
    """Page backwards through history with ``before_id`` (oldest message id you have)."""
    msgs, more = msg_svc.history(db, p, group_id, before_id=before_id, limit=limit_)
    return {"messages": msgs, "has_more": more}


@router.post("/groups/{group_id}/messages", response_model=s.MessageOut, status_code=201, tags=["messages"],
             dependencies=[Depends(limit("send_message", 30, 60, per="principal"))])
def send_message(group_id: str, body: s.MessageCreateIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return msg_svc.send(db, p, group_id, body.body)


@router.post("/groups/{group_id}/read", response_model=s.UnreadOut, tags=["messages"])
def mark_read(group_id: str, body: s.MarkReadIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return {"group_id": group_id, "unread_count": msg_svc.mark_read(db, p, group_id, body.message_id)}


@router.get("/groups/{group_id}/pinned-events", response_model=list[s.EventSummary], tags=["events"])
def pinned_events(group_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Upcoming pinned events for the group header, soonest first."""
    return msg_svc.pinned_events(db, p, group_id)
