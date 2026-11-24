from datetime import timedelta

from app.db import utcnow
from app.services.runtime import rt


def kinds(client, api, token):
    return [n["kind"] for n in client.get("/notifications", headers=api.h(token)).json()]


def setup_two_groups(client, api):
    owner = api.register("Owner")
    g1 = api.group(owner, name="G1")
    g2 = api.group(owner, name="G2")
    a = api.invite_guest(owner, g1, "a@example.com", name="A")
    b = api.invite_guest(owner, g2, "b@example.com", name="B")
    return owner, g1, g2, a, b


def test_event_create_posts_messages_pins_and_notifies(client, api):
    owner, g1, g2, a, b = setup_two_groups(client, api)
    eid = api.event(owner, [g1, g2], location={"name": "Park", "latitude": 1.5, "longitude": 2.5}, min_participants=2, max_participants=3)

    for token, gid in ((a, g1), (b, g2)):
        msgs = client.get(f"/groups/{gid}/messages", headers=api.h(token)).json()["messages"]
        card = [m for m in msgs if m["kind"] == "event"][0]
        assert card["event"]["id"] == eid and card["event"]["my_rsvp"] is False
        pinned = client.get(f"/groups/{gid}/pinned-events", headers=api.h(token)).json()
        assert [p["id"] for p in pinned] == [eid]
        assert "new_event" in kinds(client, api, token)
    assert "new_event" not in kinds(client, api, owner)

    # Each member only sees the groups they belong to
    assert client.get(f"/events/{eid}", headers=api.h(a)).json()["group_ids"] == [g1]


def test_event_validation_and_access(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    other = api.register("Other")
    other_group = api.group(other)
    h = api.h(owner)
    future = (utcnow() + timedelta(days=1)).isoformat()
    past = (utcnow() - timedelta(days=1)).isoformat()
    assert client.post("/events", json={"name": "x", "starts_at": past, "group_ids": [gid]}, headers=h).status_code == 400
    assert client.post("/events", json={"name": "x", "starts_at": "2099-01-01T10:00:00", "group_ids": [gid]}, headers=h).status_code == 422  # naive
    assert client.post("/events", json={"name": "x", "starts_at": future, "group_ids": [gid], "min_participants": 5, "max_participants": 2}, headers=h).status_code == 422
    assert client.post("/events", json={"name": "x", "starts_at": future, "ends_at": future, "group_ids": [gid]}, headers=h).status_code == 422
    # Can't post into a group you're not in
    assert client.post("/events", json={"name": "x", "starts_at": future, "group_ids": [gid, other_group]}, headers=h).status_code == 404

    eid = api.event(owner, [gid])
    assert client.get(f"/events/{eid}", headers=api.h(other)).status_code == 404
    assert client.post(f"/events/{eid}/rsvp", headers=api.h(other)).status_code == 404
    assert client.get(f"/events/{eid}/tasks", headers=api.h(other)).status_code == 404


def test_multi_group_event_shares_participants_and_tasks(client, api):
    owner, g1, g2, a, b = setup_two_groups(client, api)
    eid = api.event(owner, [g1, g2])
    tid = client.post(f"/events/{eid}/tasks", json={"title": "Drinks"}, headers=api.h(owner)).json()["id"]
    assert client.post(f"/events/{eid}/rsvp", headers=api.h(a)).status_code == 200
    assert client.post(f"/events/{eid}/rsvp", headers=api.h(b)).status_code == 200
    assert client.post(f"/events/{eid}/tasks/{tid}/claim", headers=api.h(a)).status_code == 200

    # B (other group) sees A's RSVP and claim
    assert client.get(f"/events/{eid}", headers=api.h(b)).json()["participant_count"] == 2
    names = {p["actor"]["display_name"] for p in client.get(f"/events/{eid}/participants", headers=api.h(b)).json()}
    assert names == {"A", "B"}
    task = client.get(f"/events/{eid}/tasks", headers=api.h(b)).json()[0]
    assert task["status"] == "claimed" and task["assignee"]["display_name"] == "A"
    # And the RSVP change was broadcast to both groups' members
    published = [(k, p) for k, p in rt().hub.published if p["type"] == "rsvp.changed"]
    assert any(k.startswith("guest:") for k, _ in published)


def test_share_to_additional_group(client, api):
    owner, g1, g2, a, b = setup_two_groups(client, api)
    eid = api.event(owner, [g1])
    assert client.get(f"/events/{eid}", headers=api.h(b)).status_code == 404
    assert client.post(f"/events/{eid}/share", json={"group_ids": [g2]}, headers=api.h(owner)).status_code == 200
    assert client.get(f"/events/{eid}", headers=api.h(b)).status_code == 200


def test_rsvp_limits_duplicates_and_min(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    guests = [api.invite_guest(owner, gid, f"g{i}@example.com", name=f"G{i}") for i in range(3)]
    eid = api.event(owner, [gid], min_participants=2, max_participants=2)

    r = client.post(f"/events/{eid}/rsvp", headers=api.h(guests[0])).json()
    assert r["participating"] and r["participant_count"] == 1 and not r["min_reached"]
    dup = client.post(f"/events/{eid}/rsvp", headers=api.h(guests[0]))
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "already_participating"

    r = client.post(f"/events/{eid}/rsvp", headers=api.h(guests[1])).json()
    assert r["min_reached"] and r["is_full"]
    full = client.post(f"/events/{eid}/rsvp", headers=api.h(guests[2]))
    assert full.status_code == 409 and full.json()["error"]["code"] == "event_full"
    assert kinds(client, api, owner).count("min_participants_reached") == 1

    # Withdraw frees a place
    r = client.delete(f"/events/{eid}/rsvp", headers=api.h(guests[0])).json()
    assert r["participant_count"] == 1 and not r["participating"]
    assert client.delete(f"/events/{eid}/rsvp", headers=api.h(guests[0])).status_code == 409
    assert client.post(f"/events/{eid}/rsvp", headers=api.h(guests[2])).status_code == 200


def test_edit_and_cancel_notify_participants(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    g = api.invite_guest(owner, gid, "g@example.com")
    other = api.invite_guest(owner, gid, "o@example.com")
    eid = api.event(owner, [gid], max_participants=5)
    client.post(f"/events/{eid}/rsvp", headers=api.h(g))

    assert client.patch(f"/events/{eid}", json={"name": "Hack"}, headers=api.h(g)).status_code == 403
    r = client.patch(f"/events/{eid}", json={"name": "BBQ", "starts_at": (utcnow() + timedelta(days=3)).isoformat()}, headers=api.h(owner))
    assert r.status_code == 200 and r.json()["name"] == "BBQ"
    note = client.get("/notifications", headers=api.h(g)).json()[0]
    assert note["kind"] == "event_updated" and set(note["data"]["changed"]) == {"name", "starts_at"}
    assert "event_updated" not in kinds(client, api, other)  # not a participant

    assert client.patch(f"/events/{eid}", json={"max_participants": 0}, headers=api.h(owner)).status_code == 422

    assert client.post(f"/events/{eid}/cancel", headers=api.h(owner)).json()["status"] == "cancelled"
    assert client.get("/notifications", headers=api.h(g)).json()[0]["kind"] == "event_cancelled"
    assert client.get(f"/groups/{gid}/pinned-events", headers=api.h(g)).json() == []
    assert client.post(f"/events/{eid}/rsvp", headers=api.h(other)).json()["error"]["code"] == "event_cancelled"


def test_max_cannot_drop_below_current_participants(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    gs = [api.invite_guest(owner, gid, f"g{i}@example.com") for i in range(3)]
    eid = api.event(owner, [gid])
    for g in gs:
        client.post(f"/events/{eid}/rsvp", headers=api.h(g))
    r = client.patch(f"/events/{eid}", json={"max_participants": 2}, headers=api.h(owner))
    assert r.status_code == 409 and r.json()["error"]["code"] == "max_below_participants"


def test_task_lifecycle(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    a = api.invite_guest(owner, gid, "a@example.com", name="A")
    b = api.invite_guest(owner, gid, "b@example.com", name="B")
    eid = api.event(owner, [gid])

    assert client.post(f"/events/{eid}/tasks", json={"title": "x"}, headers=api.h(a)).status_code == 403
    t1 = client.post(f"/events/{eid}/tasks", json={"title": "Bring chairs"}, headers=api.h(owner)).json()["id"]
    t2 = client.post(f"/events/{eid}/tasks", json={"title": "Bring food"}, headers=api.h(owner)).json()["id"]

    # Must be a participant to claim
    r = client.post(f"/events/{eid}/tasks/{t1}/claim", headers=api.h(a))
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_participating"
    client.post(f"/events/{eid}/rsvp", headers=api.h(a))
    client.post(f"/events/{eid}/rsvp", headers=api.h(b))

    assert client.post(f"/events/{eid}/tasks/{t1}/claim", headers=api.h(a)).json()["status"] == "claimed"
    r = client.post(f"/events/{eid}/tasks/{t1}/claim", headers=api.h(b))
    assert r.status_code == 409 and r.json()["error"]["code"] == "task_already_claimed"
    assert client.post(f"/events/{eid}/tasks/{t1}/unclaim", headers=api.h(b)).status_code == 403
    assert client.post(f"/events/{eid}/tasks/{t1}/complete", headers=api.h(b)).status_code == 403

    assert [t["id"] for t in client.get("/me/tasks", headers=api.h(a)).json()] == [t1]
    assert client.post(f"/events/{eid}/tasks/{t1}/unclaim", headers=api.h(a)).json()["status"] == "open"
    assert client.get("/me/tasks", headers=api.h(a)).json() == []

    client.post(f"/events/{eid}/tasks/{t1}/claim", headers=api.h(b))
    done = client.post(f"/events/{eid}/tasks/{t1}/complete", headers=api.h(b)).json()
    assert done["status"] == "completed" and done["completed_at"]
    assert client.post(f"/events/{eid}/tasks/{t1}/unclaim", headers=api.h(b)).status_code == 409
    assert client.get("/me/tasks", headers=api.h(b)).json() == []

    # Withdrawing releases unfinished claims
    client.post(f"/events/{eid}/tasks/{t2}/claim", headers=api.h(a))
    client.delete(f"/events/{eid}/rsvp", headers=api.h(a))
    tasks = {t["id"]: t for t in client.get(f"/events/{eid}/tasks", headers=api.h(owner)).json()}
    assert tasks[t2]["status"] == "open" and tasks[t1]["status"] == "completed"
    assert client.get(f"/events/{eid}", headers=api.h(owner)).json()["task_counts"] == {"open": 1, "claimed": 0, "completed": 1}

    # Creator can edit/delete
    assert client.patch(f"/events/{eid}/tasks/{t2}", json={"title": "Bring snacks"}, headers=api.h(owner)).json()["title"] == "Bring snacks"
    assert client.delete(f"/events/{eid}/tasks/{t2}", headers=api.h(owner)).status_code == 204


def test_ics_export(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    eid = api.event(owner, [gid], description="Bring, a; hat", location={"name": "Park"})
    r = client.get(f"/events/{eid}/ics", headers=api.h(owner))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/calendar")
    assert "BEGIN:VEVENT" in r.text and "DESCRIPTION:Bring\\, a\\; hat" in r.text
