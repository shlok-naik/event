"""Outbound delivery channels: email, the external push-notification API and the
in-process realtime (WebSocket) hub."""
import asyncio
import json
import logging
import smtplib
import threading
from dataclasses import dataclass, field
from email.message import EmailMessage

import httpx

from app.config import Settings

log = logging.getLogger("event.delivery")


# --------------------------------------------------------------------------- email


@dataclass
class OutgoingEmail:
    to: str
    subject: str
    text: str


class EmailSender:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.outbox: list[OutgoingEmail] = []  # used by the "memory" backend (tests)

    def send(self, to: str, subject: str, text: str) -> None:
        backend = self.settings.email_backend
        if backend == "memory":
            self.outbox.append(OutgoingEmail(to, subject, text))
            return
        if backend == "console":
            log.info("EMAIL to=%s subject=%s\n%s", to, subject, text)
            return
        if backend == "smtp":
            self._send_smtp(to, subject, text)
            return
        raise ValueError(f"Unknown EMAIL_BACKEND {backend!r}")

    def _send_smtp(self, to: str, subject: str, text: str) -> None:
        s = self.settings
        if not s.smtp_host:
            raise RuntimeError("SMTP_HOST is not configured")
        msg = EmailMessage()
        msg["From"] = s.email_from
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(text)
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=10) as smtp:
            if s.smtp_use_tls:
                smtp.starttls()
            if s.smtp_username and s.smtp_password:
                smtp.login(s.smtp_username, s.smtp_password.get_secret_value())
            smtp.send_message(msg)


# --------------------------------------------------------------------------- push API


class PushClient:
    """Client for the external notification API (owned by Kyrill).

    Payload contract (POST ``NOTIFICATION_WEBHOOK_URL``, header ``Authorization: Bearer <key>``)::

        {"id", "recipient": {"type": "user"|"guest", "id"}, "kind", "title", "body",
         "data": {...}, "created_at"}

    See docs/API.md "Notification API contract".
    """

    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None):
        self.settings = settings
        self.sent: list[dict] = []  # "memory" backend
        self._transport = transport

    def send(self, payload: dict) -> bool:
        backend = self.settings.notification_backend
        if backend == "memory":
            self.sent.append(payload)
            return True
        if backend == "log":
            log.info("PUSH %s", json.dumps(payload, default=str))
            return True
        if backend == "webhook":
            if not self.settings.notification_webhook_url:
                log.warning("NOTIFICATION_WEBHOOK_URL not set; push skipped")
                return False
            headers = {}
            if self.settings.notification_api_key:
                headers["Authorization"] = f"Bearer {self.settings.notification_api_key.get_secret_value()}"
            try:
                with httpx.Client(timeout=5, transport=self._transport) as client:
                    r = client.post(self.settings.notification_webhook_url, json=payload, headers=headers)
                    r.raise_for_status()
                return True
            except httpx.HTTPError as exc:
                log.warning("Push delivery failed: %s", exc)
                return False
        raise ValueError(f"Unknown NOTIFICATION_BACKEND {backend!r}")


# --------------------------------------------------------------------------- realtime hub


def actor_key(user_id: str | None, guest_id: str | None) -> str:
    return f"user:{user_id}" if user_id else f"guest:{guest_id}"


@dataclass
class RealtimeHub:
    """Tracks open WebSocket connections per principal and fans out JSON events.

    Single-process only. To run several API workers, replace with Redis pub/sub.
    ``publish`` is thread-safe so it can be called from sync endpoints.
    """

    connections: dict[str, set] = field(default_factory=dict)
    loop: asyncio.AbstractEventLoop | None = None
    published: list[tuple[str, dict]] = field(default_factory=list)  # recent events, for tests
    record: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def register(self, key: str, ws) -> None:
        self.loop = asyncio.get_running_loop()
        with self._lock:
            self.connections.setdefault(key, set()).add(ws)

    def unregister(self, key: str, ws) -> None:
        with self._lock:
            conns = self.connections.get(key)
            if conns:
                conns.discard(ws)
                if not conns:
                    self.connections.pop(key, None)

    def publish(self, keys: set[str], payload: dict) -> None:
        data = json.dumps(payload, default=str)
        with self._lock:
            if self.record:
                for k in keys:
                    self.published.append((k, payload))
            targets = [ws for k in keys for ws in self.connections.get(k, ())]
        if not targets or self.loop is None or self.loop.is_closed():
            return
        for ws in targets:
            self.loop.call_soon_threadsafe(lambda ws=ws: asyncio.ensure_future(self._safe_send(ws, data)))

    @staticmethod
    async def _safe_send(ws, data: str) -> None:
        try:
            await ws.send_text(data)
        except Exception:  # connection closed mid-send; it unregisters itself
            pass
