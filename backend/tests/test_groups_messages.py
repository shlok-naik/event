from app.services.runtime import rt

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


def test_group_crud_and_permissions(client, api):
    owner = api.register("Owner")
    loc = {"name": "Hyde Park", "latitude": 51.507, "longitude": -0.165}
    gid = api.group(owner, name="Runners", location=loc)
    g = client.get(f"/groups/{gid}", headers=api.h(owner)).json()
    assert g["my_role"] == "owner" and g["location"]["latitude"] == 51.507 and g["member_count"] == 1

    outsider = api.register("Out")
    for method, url in [("get", f"/groups/{gid}"), ("get", f"/groups/{gid}/messages"), ("get", f"/groups/{gid}/members"), ("delete", f"/groups/{gid}")]:
        assert getattr(client, method)(url, headers=api.h(outsider)).status_code == 404

    member = api.register("Mem")
    api.invite_user(owner, gid, member)
    assert client.patch(f"/groups/{gid}", json={"name": "X"}, headers=api.h(member)).status_code == 403
    assert client.patch(f"/groups/{gid}", json={"name": "Walkers"}, headers=api.h(owner)).json()["name"] == "Walkers"
    assert client.delete(f"/groups/{gid}", headers=api.h(member)).status_code == 403
    eid = api.event(owner, [gid])
    assert client.delete(f"/groups/{gid}", headers=api.h(owner)).status_code == 204
    assert client.get(f"/groups/{gid}", headers=api.h(owner)).status_code == 404
    assert client.get(f"/events/{eid}", headers=api.h(owner)).status_code == 404  # sole-group event removed


def test_validation(client, api):
    owner = api.register("Owner")
    h = api.h(owner)
    assert client.post("/groups", json={"name": ""}, headers=h).status_code == 422
    assert client.post("/groups", json={"name": "a", "location": {"latitude": 95, "longitude": 0}}, headers=h).status_code == 422
    assert client.post("/groups", json={"name": "a", "location": {"latitude": 50}}, headers=h).status_code == 422
    assert client.post("/groups", json={"name": "a", "image_url": "javascript:alert(1)"}, headers=h).status_code == 422
    assert client.post("/groups", json={"name": "a", "is_admin": True}, headers=h).status_code == 422


def test_locations_only_for_own_groups(client, api):
    a = api.register("A")
    b = api.register("B")
    api.group(a, name="A1", location={"latitude": 1, "longitude": 1})
    api.group(b, name="B1", location={"latitude": 2, "longitude": 2})
    api.group(b, name="NoLoc")
    locs = client.get("/groups/locations", headers=api.h(a)).json()
    assert [l["name"] for l in locs] == ["A1"]


def test_member_emails_only_visible_to_admins(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    guest = api.invite_guest(owner, gid, "guest@example.com")
    owner_view = client.get(f"/groups/{gid}/members", headers=api.h(owner)).json()
    guest_view = client.get(f"/groups/{gid}/members", headers=api.h(guest)).json()
    assert {m["email"] for m in owner_view} >= {"guest@example.com"}
    assert all(m["email"] is None for m in guest_view)


def test_roles_leave_and_remove(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    bob = api.register("Bob")
    api.invite_user(owner, gid, bob)
    guest = api.invite_guest(owner, gid, "g@example.com")
    members = {m["actor"]["display_name"]: m for m in client.get(f"/groups/{gid}/members", headers=api.h(owner)).json()}

    assert client.patch(f"/groups/{gid}/members/{members['Gus']['membership_id']}", json={"role": "admin"}, headers=api.h(owner)).status_code == 400
    assert client.patch(f"/groups/{gid}/members/{members['Bob']['membership_id']}", json={"role": "admin"}, headers=api.h(owner)).status_code == 200
    # Admin removes guest
    assert client.delete(f"/groups/{gid}/members/{members['Gus']['membership_id']}", headers=api.h(bob)).status_code == 204
    assert client.get(f"/groups/{gid}", headers=api.h(guest)).status_code == 404
    # Admin can't remove owner; sole owner can't leave
    assert client.delete(f"/groups/{gid}/members/{members['Owner']['membership_id']}", headers=api.h(bob)).status_code == 403
    assert client.delete(f"/groups/{gid}/members/{members['Owner']['membership_id']}", headers=api.h(owner)).status_code == 409
    # Bob leaves
    assert client.delete(f"/groups/{gid}/members/{members['Bob']['membership_id']}", headers=api.h(bob)).status_code == 204


def test_group_image_upload(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    r = client.post(f"/groups/{gid}/image", files={"file": ("a.png", PNG, "image/png")}, headers=api.h(owner))
    assert r.status_code == 200 and r.json()["image_url"].startswith("/media/groups/")
    assert client.get(r.json()["image_url"]).status_code == 200
    r = client.post(f"/groups/{gid}/image", files={"file": ("a.png", b"<svg onload=alert(1)>", "image/png")}, headers=api.h(owner))
    assert r.status_code == 400


def test_messaging_history_unread(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    guest = api.invite_guest(owner, gid, "g@example.com")
    for i in range(5):
        assert client.post(f"/groups/{gid}/messages", json={"body": f"m{i}"}, headers=api.h(owner)).status_code == 201

    g = client.get(f"/groups/{gid}", headers=api.h(guest)).json()
    assert g["unread_count"] == 5
    assert client.get(f"/groups/{gid}", headers=api.h(owner)).json()["unread_count"] == 0  # own messages

    page = client.get(f"/groups/{gid}/messages?limit=3", headers=api.h(guest)).json()
    assert [m["body"] for m in page["messages"]] == ["m2", "m3", "m4"] and page["has_more"]
    older = client.get(f"/groups/{gid}/messages?limit=10&before_id={page['messages'][0]['id']}", headers=api.h(guest)).json()
    assert [m["body"] for m in older["messages"] if m["kind"] == "text"] == ["m0", "m1"]
    assert page["messages"][0]["sender"]["display_name"] == "Owner"
    assert page["messages"][0]["created_at"]

    r = client.post(f"/groups/{gid}/read", json={"message_id": page["messages"][1]["id"]}, headers=api.h(guest))
    assert r.json()["unread_count"] == 1
    # Read position never moves backwards
    r = client.post(f"/groups/{gid}/read", json={"message_id": 1}, headers=api.h(guest))
    assert r.json()["unread_count"] == 1

    assert client.post(f"/groups/{gid}/messages", json={"body": ""}, headers=api.h(guest)).status_code == 422
    assert client.post(f"/groups/{gid}/messages", json={"body": "x" * 4001}, headers=api.h(guest)).status_code == 422


def test_non_member_cannot_message(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    other = api.register("Other")
    assert client.post(f"/groups/{gid}/messages", json={"body": "hi"}, headers=api.h(other)).status_code == 404


def test_realtime_websocket(client, api):
    owner = api.register("Owner")
    gid = api.group(owner)
    guest = api.invite_guest(owner, gid, "g@example.com")
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "auth", "token": guest})
        assert ws.receive_json()["type"] == "ready"
        client.post(f"/groups/{gid}/messages", json={"body": "live!"}, headers=api.h(owner))
        evt = ws.receive_json()
        assert evt["type"] == "message.created" and evt["message"]["body"] == "live!"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_websocket_rejects_bad_token(client):
    from starlette.websockets import WebSocketDisconnect

    import pytest

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "auth", "token": "nope"})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4401


def test_invite_sends_emails_to_multiple_and_skips_members(client, api):
    owner = api.register("Owner", email="owner@example.com")
    gid = api.group(owner)
    rt().email.outbox.clear()
    r = client.post(f"/groups/{gid}/invitations", json={"emails": ["a@example.com", "b@example.com", "owner@example.com"]}, headers=api.h(owner))
    assert r.json()["already_members"] == ["owner@example.com"]
    assert sorted(m.to for m in rt().email.outbox) == ["a@example.com", "b@example.com"]
    assert "http://app.test/invite?token=" in rt().email.outbox[0].text
    # Re-inviting revokes the older link
    old = api.last_email_token("a@example.com")
    client.post(f"/groups/{gid}/invitations", json={"emails": ["a@example.com"]}, headers=api.h(owner))
    assert client.post("/invitations/accept", json={"token": old}).status_code == 404
    assert client.post("/invitations/accept", json={"token": api.last_email_token("a@example.com")}).status_code == 200
