from datetime import timedelta

import httpx
from pydantic import SecretStr
from sqlalchemy import func, select, update

from app.db import utcnow
from app.models import RSVP, Event, EventGroup, Notification, Reminder, Task, TaskAssignment
from app.services import cleanup, reminders
from app.services.maps import MapsClient
from app.services.runtime import rt


def _count(db, model, **where):
    q = select(func.count()).select_from(model)
    for k, v in where.items():
        q = q.where(getattr(model, k) == v)
    return db.scalar(q)


def test_automatic_event_deletion(client, api, db):
    owner = api.register("Owner")
    gid = api.group(owner)
    g = api.invite_guest(owner, gid, "g@example.com")
    eid = api.event(owner, [gid], hours=72)
    tid = client.post(f"/events/{eid}/tasks", json={"title": "x"}, headers=api.h(owner)).json()["id"]
    client.post(f"/events/{eid}/rsvp", headers=api.h(g))
    client.post(f"/events/{eid}/tasks/{tid}/claim", headers=api.h(g))
    assert _count(db, Reminder, event_id=eid) == 1

    # Not yet over: nothing deleted
    assert cleanup.purge_expired_events(db) == 0

    # Event is over -> immediately unreachable through every old reference, even before purge
    db.execute(update(Event).where(Event.id == eid).values(expires_at=utcnow() - timedelta(minutes=1)))
    db.commit()
    assert client.get(f"/events/{eid}", headers=api.h(g)).status_code == 404
    assert client.get(f"/events/{eid}/tasks", headers=api.h(g)).status_code == 404
    assert client.post(f"/events/{eid}/rsvp", headers=api.h(g)).status_code == 404
    assert client.get(f"/events/{eid}/ics", headers=api.h(g)).status_code == 404
    assert client.get("/me/tasks", headers=api.h(g)).json() == []
    assert client.get(f"/groups/{gid}/pinned-events", headers=api.h(g)).json() == []
    msgs = client.get(f"/groups/{gid}/messages", headers=api.h(g)).json()["messages"]
    assert all(m["event"] is None for m in msgs) and any(m["kind"] == "event_expired" for m in msgs)

    # Purge removes everything attached
    assert cleanup.purge_expired_events(db) == 1
    db.expire_all()
    assert db.get(Event, eid) is None
    for model in (RSVP, Task, Reminder, EventGroup, Notification):
        assert _count(db, model, event_id=eid) == 0
    assert _count(db, TaskAssignment, task_id=tid) == 0
    msgs = client.get(f"/groups/{gid}/messages", headers=api.h(g)).json()["messages"]
    assert any(m["kind"] == "event_expired" for m in msgs) and all(m["kind"] != "event" for m in msgs)
    assert any(p["type"] == "event.deleted" for _, p in rt().hub.published)


def test_standard_reminder_sent_when_due(client, api, db):
    owner = api.register("Owner")
    gid = api.group(owner)
    g = api.invite_guest(owner, gid, "g@example.com")
    eid = api.event(owner, [gid], hours=30)
    client.post(f"/events/{eid}/rsvp", headers=api.h(g))
    assert reminders.run_due_reminders(db) == 0  # due at start-24h, i.e. ~6h from now
    assert reminders.run_due_reminders(db, now=utcnow() + timedelta(hours=7)) == 1
    assert client.get("/notifications", headers=api.h(g)).json()[0]["kind"] == "event_reminder"
    assert reminders.run_due_reminders(db, now=utcnow() + timedelta(hours=8)) == 0  # never twice
    assert any(p["kind"] == "event_reminder" for p in rt().push.sent)


def test_cancel_cancels_reminders(client, api, db):
    owner = api.register("Owner")
    gid = api.group(owner)
    g = api.invite_guest(owner, gid, "g@example.com")
    eid = api.event(owner, [gid], hours=30)
    client.post(f"/events/{eid}/rsvp", headers=api.h(g))
    client.post(f"/events/{eid}/cancel", headers=api.h(owner))
    assert reminders.run_due_reminders(db, now=utcnow() + timedelta(hours=7)) == 0
    assert db.scalar(select(Reminder).where(Reminder.event_id == eid)).cancelled_at is not None


def test_smart_reminders(client, api, db):
    owner = api.register("Owner")
    gid = api.group(owner)
    a = api.invite_guest(owner, gid, "a@example.com")
    b = api.invite_guest(owner, gid, "b@example.com")
    eid = api.event(owner, [gid], hours=20, min_participants=3)
    t1 = client.post(f"/events/{eid}/tasks", json={"title": "x"}, headers=api.h(owner)).json()["id"]
    client.post(f"/events/{eid}/tasks", json={"title": "y"}, headers=api.h(owner))
    client.post(f"/events/{eid}/rsvp", headers=api.h(a))
    client.post(f"/events/{eid}/tasks/{t1}/claim", headers=api.h(a))

    created = reminders.generate_smart_reminders(db)
    assert created > 0
    assert reminders.generate_smart_reminders(db) == 0  # idempotent
    reminders.run_due_reminders(db)
    a_kinds = {n["kind"] for n in client.get("/notifications", headers=api.h(a)).json()}
    b_titles = [n["title"] for n in client.get("/notifications", headers=api.h(b)).json()]
    assert {"task_reminder", "smart_reminder"} <= a_kinds  # unfinished task + unclaimed task
    assert any("needs 2 more people" in t for t in b_titles)  # min not reached, b hasn't joined


def test_notification_preferences_respected(client, api, db):
    owner = api.register("Owner")
    gid = api.group(owner)
    g = api.invite_guest(owner, gid, "g@example.com")
    r = client.patch("/notifications/preferences", json={"new_events": False, "push_enabled": False}, headers=api.h(g))
    assert r.status_code == 200 and r.json()["new_events"] is False
    rt().push.sent.clear()
    api.event(owner, [gid])
    assert "new_event" not in [n["kind"] for n in client.get("/notifications", headers=api.h(g)).json()]

    client.patch("/notifications/preferences", json={"new_events": True}, headers=api.h(g))
    api.event(owner, [gid])
    notes = client.get("/notifications?unread_only=true", headers=api.h(g)).json()
    assert notes[0]["kind"] == "new_event"
    assert not any(p["recipient"]["type"] == "guest" for p in rt().push.sent)  # push disabled
    client.post("/notifications/read", json={}, headers=api.h(g))
    assert client.get("/notifications?unread_only=true", headers=api.h(g)).json() == []


def test_email_notifications_when_enabled(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    g = api.invite_guest(owner, gid, "g@example.com")
    client.patch("/notifications/preferences", json={"email_enabled": True}, headers=api.h(g))
    rt().email.outbox.clear()
    api.event(owner, [gid])
    assert [m.subject for m in rt().email.outbox if m.to == "g@example.com"] == ["New event: Picnic"]


def test_maps_proxy(client, api, app):
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        if "searchText" in str(request.url):
            return httpx.Response(200, json={"places": [{"id": "p1", "displayName": {"text": "Cafe"}, "formattedAddress": "1 Road", "location": {"latitude": 1.0, "longitude": 2.0}}]})
        return httpx.Response(200, json={"status": "OK", "results": [{"place_id": "p2", "formatted_address": "2 Road", "geometry": {"location": {"lat": 3.0, "lng": 4.0}}}]})

    token = api.register("U")
    assert client.get("/locations/search?q=cafe", headers=api.h(token)).status_code == 503  # no key configured

    settings = rt().settings.model_copy(update={"google_maps_api_key": SecretStr("test-key")})
    app.state.maps = MapsClient(settings, transport=httpx.MockTransport(handler))
    r = client.get("/locations/search?q=cafe&lat=1&lng=2", headers=api.h(token))
    assert r.json() == [{"place_id": "p1", "name": "Cafe", "address": "1 Road", "latitude": 1.0, "longitude": 2.0}]
    assert calls[-1].headers["X-Goog-Api-Key"] == "test-key"
    assert client.get("/locations/geocode?address=2%20Road", headers=api.h(token)).json()[0]["latitude"] == 3.0
    assert client.get("/locations/reverse?lat=3&lng=4", headers=api.h(token)).json()[0]["address"] == "2 Road"
    assert client.get("/locations/search?q=cafe").status_code == 401
    # The key never appears in responses
    assert "test-key" not in r.text


def test_rate_limiting(client, api):
    from app.ratelimit import limiter

    limiter.enabled = True
    try:
        codes = [client.post("/auth/login", json={"email": "a@example.com", "password": "whatever1"}).status_code for _ in range(12)]
        assert codes[:10] == [401] * 10 and codes[10:] == [429, 429]
    finally:
        limiter.enabled = False
