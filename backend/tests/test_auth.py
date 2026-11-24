from app.services.runtime import rt


def test_register_login_me_logout(client, api):
    r = client.post("/auth/register", json={"email": "Ann@Example.com", "password": "password123", "display_name": "Ann"})
    assert r.status_code == 201
    assert r.json()["principal"]["email"] == "ann@example.com"

    r = client.post("/auth/login", json={"email": "ann@example.com", "password": "password123"})
    assert r.status_code == 200
    token = r.json()["token"]
    assert client.get("/auth/me", headers=api.h(token)).json()["type"] == "user"

    assert client.post("/auth/logout", headers=api.h(token)).status_code == 200
    assert client.get("/auth/me", headers=api.h(token)).status_code == 401


def test_register_validation_and_duplicates(client):
    assert client.post("/auth/register", json={"email": "x@example.com", "password": "short", "display_name": "X"}).status_code == 422
    assert client.post("/auth/register", json={"email": "not-an-email", "password": "password123", "display_name": "X"}).status_code == 422
    body = {"email": "x@example.com", "password": "password123", "display_name": "X"}
    assert client.post("/auth/register", json=body).status_code == 201
    r = client.post("/auth/register", json=body)
    assert r.status_code == 409 and r.json()["error"]["code"] == "email_taken"


def test_wrong_password_and_bad_token(client, api):
    api.register("Bob", email="bob@example.com")
    r = client.post("/auth/login", json={"email": "bob@example.com", "password": "nope-nope"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    assert client.post("/auth/login", json={"email": "ghost@example.com", "password": "nope-nope"}).status_code == 401
    assert client.get("/groups", headers=api.h("garbage-token")).status_code == 401
    assert client.get("/groups").status_code == 401


def test_guest_invitation_flow(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    r = client.post(f"/groups/{gid}/invitations", json={"emails": ["g1@example.com", "G2@example.com", "g1@example.com"]}, headers=api.h(owner))
    assert r.status_code == 201
    assert sorted(i["email"] for i in r.json()["invited"]) == ["g1@example.com", "g2@example.com"]

    token = api.last_email_token("g1@example.com")
    preview = client.post("/invitations/preview", json={"token": token}).json()
    assert preview["group_name"] == "Hikers" and preview["requires_login"] is False

    r = client.post("/invitations/accept", json={"token": token, "display_name": "Gina"})
    assert r.status_code == 200
    guest = r.json()["session"]["token"]
    assert client.get("/auth/me", headers=api.h(guest)).json()["type"] == "guest"
    assert [g["id"] for g in client.get("/groups", headers=api.h(guest)).json()] == [gid]

    # Single use
    assert client.post("/invitations/accept", json={"token": token}).status_code == 404


def test_guest_cannot_create_groups_or_events(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    guest = api.invite_guest(owner, gid, "g@example.com")
    assert client.post("/groups", json={"name": "Nope"}, headers=api.h(guest)).json()["error"]["code"] == "registration_required"
    r = client.post("/events", json={"name": "x", "starts_at": "2099-01-01T10:00:00Z", "group_ids": [gid]}, headers=api.h(guest))
    assert r.status_code == 403
    assert client.post(f"/groups/{gid}/invitations", json={"emails": ["z@example.com"]}, headers=api.h(guest)).status_code == 403


def test_invitation_for_registered_email_requires_login(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    bob = api.register("Bob", email="bob@example.com")
    client.post(f"/groups/{gid}/invitations", json={"emails": ["bob@example.com"]}, headers=api.h(owner))
    token = api.last_email_token("bob@example.com")
    r = client.post("/invitations/accept", json={"token": token})
    assert r.status_code == 401 and r.json()["error"]["code"] == "login_required"
    # Another logged-in user cannot use Bob's link either
    eve = api.register("Eve")
    assert client.post("/invitations/accept", json={"token": token}, headers=api.h(eve)).status_code == 401
    assert client.post("/invitations/accept", json={"token": token}, headers=api.h(bob)).status_code == 200


def test_in_app_invitation_acceptance(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    bob = api.register("Bob", email="bob@example.com")
    client.post(f"/groups/{gid}/invitations", json={"emails": ["bob@example.com"]}, headers=api.h(owner))
    notes = client.get("/notifications", headers=api.h(bob)).json()
    assert notes[0]["kind"] == "group_invite"
    inv_id = notes[0]["data"]["invitation_id"]
    eve = api.register("Eve")
    assert client.post(f"/invitations/{inv_id}/accept", headers=api.h(eve)).status_code == 404
    assert client.post(f"/invitations/{inv_id}/accept", headers=api.h(bob)).status_code == 200


def test_guest_magic_link(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    api.invite_guest(owner, gid, "g@example.com")
    rt().email.outbox.clear()
    assert client.post("/auth/guest/magic-link", json={"email": "unknown@example.com"}).status_code == 202
    assert rt().email.outbox == []
    assert client.post("/auth/guest/magic-link", json={"email": "g@example.com"}).status_code == 202
    token = api.last_email_token("g@example.com")
    r = client.post("/auth/guest/session", json={"token": token})
    assert r.status_code == 200 and r.json()["principal"]["type"] == "guest"
    assert client.post("/auth/guest/session", json={"token": token}).status_code == 401  # one-time


def test_guest_upgrade_keeps_data(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    guest = api.invite_guest(owner, gid, "g@example.com", name="Gus")
    eid = api.event(owner, [gid])
    tid = client.post(f"/events/{eid}/tasks", json={"title": "Bring cake"}, headers=api.h(owner)).json()["id"]
    client.post(f"/groups/{gid}/messages", json={"body": "hi from guest"}, headers=api.h(guest))
    assert client.post(f"/events/{eid}/rsvp", headers=api.h(guest)).status_code == 200
    assert client.post(f"/events/{eid}/tasks/{tid}/claim", headers=api.h(guest)).status_code == 200

    # Registering over the guest's email is refused (would hijack the guest's data)
    r = client.post("/auth/register", json={"email": "g@example.com", "password": "password123", "display_name": "X"})
    assert r.json()["error"]["code"] == "guest_upgrade_required"

    r = client.post("/auth/guest/upgrade", json={"password": "password123"}, headers=api.h(guest))
    assert r.status_code == 200
    user = r.json()["token"]
    me = client.get("/auth/me", headers=api.h(user)).json()
    assert me["type"] == "user" and me["display_name"] == "Gus"

    assert client.get("/auth/me", headers=api.h(guest)).status_code == 401  # guest session revoked
    assert [g["id"] for g in client.get("/groups", headers=api.h(user)).json()] == [gid]
    assert client.get(f"/events/{eid}/rsvp", headers=api.h(user)).json()["participating"] is True
    assert client.get("/me/tasks", headers=api.h(user)).json()[0]["id"] == tid
    msgs = client.get(f"/groups/{gid}/messages", headers=api.h(user)).json()["messages"]
    mine = [m for m in msgs if m["body"] == "hi from guest"][0]
    assert mine["sender"]["type"] == "user" and mine["sender"]["id"] == me["id"]
    # Now a registered user: can create events
    assert client.post("/auth/login", json={"email": "g@example.com", "password": "password123"}).status_code == 200
    api.event(user, [gid])
