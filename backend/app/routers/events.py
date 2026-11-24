from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import schemas as s
from app.deps import current_principal, current_user, get_db
from app.ratelimit import limit
from app.security import Principal
from app.services import events as svc
from app.services import rsvps as rsvp_svc
from app.services import tasks as task_svc

router = APIRouter(tags=["events"])


@router.post("/events", response_model=s.EventOut, status_code=201, dependencies=[Depends(limit("create_event", 30, 3600, per="principal"))])
def create_event(body: s.EventCreateIn, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    """Registered users only. Posts an interactive event message to every selected group,
    pins the event and notifies group members."""
    e = svc.create_event(db, p, body)
    return svc.get_event(db, p, e.id)


@router.get("/events", response_model=list[s.EventOut])
def list_events(
    group_id: str | None = None,
    include_cancelled: bool = False,
    p: Principal = Depends(current_principal),
    db: Session = Depends(get_db),
):
    """Upcoming events visible to the caller (optionally for one group)."""
    return svc.list_events(db, p, group_id=group_id, include_cancelled=include_cancelled)


@router.get("/events/{event_id}", response_model=s.EventOut)
def get_event(event_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return svc.get_event(db, p, event_id)


@router.patch("/events/{event_id}", response_model=s.EventOut)
def update_event(event_id: str, body: s.EventUpdateIn, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    """Creator only. Participants are notified of what changed."""
    svc.update_event(db, p, event_id, body)
    return svc.get_event(db, p, event_id)


@router.post("/events/{event_id}/cancel", response_model=s.EventOut)
def cancel_event(event_id: str, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    svc.cancel_event(db, p, event_id)
    return svc.get_event(db, p, event_id)


@router.post("/events/{event_id}/share", response_model=s.EventOut)
def share_event(event_id: str, body: s.ShareEventIn, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    """Share to more groups. All groups see the same participants and tasks."""
    svc.share_event(db, p, event_id, body.group_ids)
    return svc.get_event(db, p, event_id)


class PinIn(BaseModel):
    group_id: str
    pinned: bool


@router.post("/events/{event_id}/pin", response_model=s.OkOut)
def pin_event(event_id: str, body: PinIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Group owners/admins can pin or unpin an event in their group."""
    svc.set_pinned(db, p, event_id, body.group_id, body.pinned)
    return {"ok": True}


@router.get("/events/{event_id}/ics", response_class=Response, responses={200: {"content": {"text/calendar": {}}}})
def event_ics(event_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Calendar file (.ics) to add the event to Google/Apple/Outlook calendars."""
    return Response(
        svc.to_ics(db, p, event_id),
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="event-{event_id}.ics"'},
    )


# --------------------------------------------------------------------------- RSVPs


@router.get("/events/{event_id}/participants", response_model=list[s.ParticipantOut], tags=["rsvps"])
def participants(event_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return svc.list_participants(db, p, event_id)


@router.get("/events/{event_id}/rsvp", response_model=s.RSVPStateOut, tags=["rsvps"])
def rsvp_state(event_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return rsvp_svc.my_state(db, p, event_id)


@router.post("/events/{event_id}/rsvp", response_model=s.RSVPStateOut, tags=["rsvps"],
             dependencies=[Depends(limit("rsvp", 60, 60, per="principal"))])
def rsvp(event_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Join. 409 ``event_full`` / ``already_participating`` / ``event_cancelled`` / ``event_started``."""
    return rsvp_svc.join(db, p, event_id)


@router.delete("/events/{event_id}/rsvp", response_model=s.RSVPStateOut, tags=["rsvps"],
               dependencies=[Depends(limit("rsvp", 60, 60, per="principal"))])
def withdraw(event_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Withdraw. Unfinished tasks you had claimed are released."""
    return rsvp_svc.withdraw(db, p, event_id)


# --------------------------------------------------------------------------- tasks


@router.get("/events/{event_id}/tasks", response_model=list[s.TaskOut], tags=["tasks"])
def list_tasks(event_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return task_svc.list_tasks(db, p, event_id)


@router.post("/events/{event_id}/tasks", response_model=s.TaskOut, status_code=201, tags=["tasks"])
def create_task(event_id: str, body: s.TaskCreateIn, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    """Event creator only."""
    return task_svc.create_task(db, p, event_id, body)


@router.patch("/events/{event_id}/tasks/{task_id}", response_model=s.TaskOut, tags=["tasks"])
def update_task(event_id: str, task_id: str, body: s.TaskUpdateIn, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    return task_svc.update_task(db, p, event_id, task_id, body)


@router.delete("/events/{event_id}/tasks/{task_id}", status_code=204, tags=["tasks"])
def delete_task(event_id: str, task_id: str, p: Principal = Depends(current_user), db: Session = Depends(get_db)):
    task_svc.delete_task(db, p, event_id, task_id)
    return Response(status_code=204)


@router.post("/events/{event_id}/tasks/{task_id}/claim", response_model=s.TaskOut, tags=["tasks"])
def claim_task(event_id: str, task_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Participants only. 409 ``task_already_claimed`` if someone got there first."""
    return task_svc.claim(db, p, event_id, task_id)


@router.post("/events/{event_id}/tasks/{task_id}/unclaim", response_model=s.TaskOut, tags=["tasks"])
def unclaim_task(event_id: str, task_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return task_svc.unclaim(db, p, event_id, task_id)


@router.post("/events/{event_id}/tasks/{task_id}/complete", response_model=s.TaskOut, tags=["tasks"])
def complete_task(event_id: str, task_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return task_svc.complete(db, p, event_id, task_id)


@router.get("/me/tasks", response_model=list[s.OutstandingTaskOut], tags=["tasks"])
def my_outstanding_tasks(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Tasks you claimed and have not completed yet, soonest event first."""
    return task_svc.outstanding_for(db, p)

