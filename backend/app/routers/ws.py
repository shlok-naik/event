"""Realtime WebSocket.

Protocol: connect to ``/ws``, then send ``{"type": "auth", "token": "<session token>"}``
within 10 seconds (tokens are not put in the URL so they don't end up in logs). The
server replies ``{"type": "ready"}`` and then pushes events as JSON; see docs/API.md.
Clients may send ``{"type": "ping"}`` and receive ``{"type": "pong"}``.
"""
import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from app.errors import AppError
from app.security import resolve_token
from app.services.delivery import actor_key
from app.services.runtime import rt

router = APIRouter()


def _authenticate(app, token: str):
    s = rt().settings
    db = app.state.database.SessionLocal()
    try:
        return resolve_token(db, token, user_ttl_days=s.user_session_ttl_days, guest_ttl_days=s.guest_session_ttl_days)
    finally:
        db.close()


@router.websocket("/ws")
async def websocket(ws: WebSocket):
    await ws.accept()
    try:
        first = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=10))
        principal = await run_in_threadpool(_authenticate, ws.app, str(first.get("token", "")))
        if first.get("type") != "auth":
            raise AppError("Expected auth message")
    except WebSocketDisconnect:
        return  # client went away before authenticating; nothing to close
    except (asyncio.TimeoutError, ValueError, AppError, AttributeError):
        try:
            await ws.close(code=4401)
        except Exception:  # client may already be gone (RuntimeError / ClientDisconnected)
            pass
        return

    hub = rt().hub
    key = actor_key(principal.user_id, principal.guest_id)
    hub.register(key, ws)
    try:
        await ws.send_text(json.dumps({"type": "ready", "principal": {"type": principal.kind, "id": principal.id}}))
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("type") == "ping":
                await ws.send_text('{"type": "pong"}')
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(key, ws)
