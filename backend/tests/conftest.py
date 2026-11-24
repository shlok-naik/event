import re
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database, utcnow
from app.main import create_app
from app.ratelimit import limiter
from app.services.runtime import rt


@pytest.fixture
def settings(tmp_path):
    return Settings(
        _env_file=None,
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        email_backend="memory",
        notification_backend="memory",
        push_async=False,
        scheduler_enabled=False,
        rate_limit_enabled=False,
        media_dir=str(tmp_path / "media"),
        frontend_base_url="http://app.test",
    )


@pytest.fixture
def app(settings):
    application = create_app(settings, Database(settings.database_url))
    rt().hub.record = True
    limiter.reset()
    yield application
    limiter.reset()


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db(app):
    session = app.state.database.SessionLocal()
    yield session
    session.close()


class Api:
    """Small helper around TestClient for writing readable tests."""

    def __init__(self, client):
        self.c = client
        self._n = 0

    def h(self, token):
        return {"Authorization": f"Bearer {token}"}

    def register(self, name="Alice", email=None, password="password123"):
        self._n += 1
        email = email or f"{name.lower()}{self._n}@example.com"
        r = self.c.post("/auth/register", json={"email": email, "password": password, "display_name": name})
        assert r.status_code == 201, r.text
        return r.json()["token"]

    def group(self, token, name="Hikers", **extra):
        r = self.c.post("/groups", json={"name": name, **extra}, headers=self.h(token))
        assert r.status_code == 201, r.text
        return r.json()["id"]

    def last_email_token(self, to):
        mails = [m for m in rt().email.outbox if m.to == to]
        assert mails, f"no email to {to}"
        return re.search(r"token=([\w-]+)", mails[-1].text).group(1)

    def invite_guest(self, owner_token, group_id, email, name="Gus"):
        r = self.c.post(f"/groups/{group_id}/invitations", json={"emails": [email]}, headers=self.h(owner_token))
        assert r.status_code == 201, r.text
        token = self.last_email_token(email)
        r = self.c.post("/invitations/accept", json={"token": token, "display_name": name})
        assert r.status_code == 200, r.text
        return r.json()["session"]["token"]

    def invite_user(self, owner_token, group_id, user_token):
        me = self.c.get("/auth/me", headers=self.h(user_token)).json()
        self.c.post(f"/groups/{group_id}/invitations", json={"emails": [me["email"]]}, headers=self.h(owner_token))
        token = self.last_email_token(me["email"])
        r = self.c.post("/invitations/accept", json={"token": token}, headers=self.h(user_token))
        assert r.status_code == 200, r.text

    def event(self, token, group_ids, hours=48, **extra):
        body = {"name": "Picnic", "starts_at": (utcnow() + timedelta(hours=hours)).isoformat(), "group_ids": group_ids, **extra}
        r = self.c.post("/events", json=body, headers=self.h(token))
        assert r.status_code == 201, r.text
        return r.json()["id"]


@pytest.fixture
def api(client):
    return Api(client)
