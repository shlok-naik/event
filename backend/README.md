# Event App: Backend

FastAPI + SQLAlchemy backend for a localised, group-based event organisation and messaging app.
It covers users and guests, groups, realtime chat, events shared across groups, RSVPs, tasks,
notifications and smart reminders, a Google Maps proxy, and automatic event deletion.

- **API reference and shared types**: [docs/API.md](docs/API.md), and [docs/openapi.json](docs/openapi.json)
- **Live docs** while running: http://localhost:8000/docs

## Run it

```bash
cd backend
python -m venv .venv            # on Windows with very long paths, put the venv in a short path
.venv/Scripts/activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env            # then fill in keys
uvicorn app.main:app --reload
pytest -q                       # run the tests
```

SQLite is the default (`DATABASE_URL=sqlite:///./event.db`). Tables are created on startup.
For production, point `DATABASE_URL` at PostgreSQL and add Alembic migrations.

## Layout

```
app/
  main.py            app factory, error handlers, CORS, rate limit, scheduler start-up
  config.py          settings (env / .env), secrets are read from the environment only
  db.py              engine, sessions, UTC datetime column type
  models.py          all database models (see below)
  schemas.py         request and response types (the shared data types)
  security.py        password hashing, opaque session tokens, Principal (user or guest)
  deps.py            FastAPI dependencies (db session, current user or guest)
  ratelimit.py       sliding-window rate limiter
  scheduler.py       background jobs: cleanup, smart reminders, due reminders, push outbox
  routers/           HTTP and WebSocket endpoints (thin)
  services/          business logic and permission checks (unit-testable without HTTP)
tests/               40 tests, including concurrency and cleanup
scripts/export_openapi.py
```

## Data model

| Table | Purpose |
|---|---|
| `users` | Registered accounts (email, display name, bcrypt password hash) |
| `guests` | People invited by email without an account. `upgraded_to_user_id` is set after an upgrade |
| `auth_sessions` | Bearer sessions for users or guests. Only a SHA-256 hash of the token is stored. Sessions slide and can be revoked |
| `guest_magic_links` | One-time, 30-minute sign-in links for returning guests |
| `groups` | Name, description, image, location (name, lat/lng, place id) |
| `group_memberships` | Person ↔ group, with role (owner, admin, member) and `last_read_message_id` for unread counts |
| `invitations` | Email invitations to a group. The token is emailed and only its hash is stored. Expiring, single use, revocable |
| `messages` | Group chat: `text`, `system`, `event` (interactive card) and `event_expired` |
| `events` | Name, description, location, start and end, min and max participants, atomic `participant_count`, status, `expires_at` |
| `event_groups` | Event ↔ group (shared to many groups), `pinned` flag, link to the event card message |
| `rsvps` | Person ↔ event, unique per person |
| `tasks` | Event tasks with status open, claimed or completed |
| `task_assignments` | Who claimed a task. `task_id` is unique, so a task has at most one assignee |
| `notifications` | In-app notifications, plus an outbox for the push API and email (`pushed_at`) |
| `notification_preferences` | Per-person category toggles, push and email switches, reminder lead time |
| `reminders` | Scheduled reminders, deduplicated by `dedupe_key`. Cancelled or deleted together with their event |

Every "who" column is a `(user_id, guest_id)` pair with a CHECK that exactly one is set.
That is what lets a guest upgrade without losing data: every such row is re-pointed to the new user in one transaction.

## Security notes

- Passwords are hashed with bcrypt (SHA-256 pre-hash, so passwords longer than 72 bytes still count in full). Login takes the same time whether or not the email exists.
- Session, invitation and magic-link tokens are 256-bit random values, stored only as hashes.
- Holding an invitation token proves control of the email address. If that email belongs to a registered account, the invitation can only be accepted while logged into that account.
- Registering with an email that already has guest access is refused. That guest must upgrade from their own guest session, so nobody can register over a guest and take their data.
- Every group, message, event, task and location read goes through `services/access.py`. Anything you can't access returns 404, so ids can't be probed. Ids are UUIDs.
- Group locations are only returned to members, and member emails only to owners and admins.
- RSVP and task-claim races are handled with conditional UPDATEs and unique constraints (tested with 12 concurrent threads).
- Rate limits apply globally and per endpoint (login, register, magic link, invites, messages, RSVPs, maps, uploads).
- Uploaded images are checked by their magic bytes, capped in size and stored under random names.
- The Google Maps key, SMTP password and notification API key are read from the environment only. They never appear in responses or logs.

## Background jobs

The scheduler runs every `SCHEDULER_INTERVAL_SECONDS` inside the API process. You can also run it once with `python -m app.scheduler`.

1. Purge expired events.
2. Generate smart reminders.
3. Send due reminders.
4. Flush the push and email outbox.

## Known limitations and next steps

- Realtime fan-out and rate limiting are **in-process**. To run more than one worker, move them to Redis pub/sub and a shared limiter.
- No email verification for registered accounts yet. Invitations are still safe, because the token itself proves email control.
- No Alembic migrations yet. The schema is created with `create_all`.
- An open WebSocket is not closed when its session is revoked; it is only checked when it connects.

## Optional extras

| Item | Status |
|---|---|
| Calendar sync | **Done (basic):** `GET /events/{id}/ics` exports the event to any calendar app. Next step: a per-user subscribable feed, or Google Calendar API push |
| To-do list sync | Not started. Official options: Google Tasks API (OAuth) and Microsoft To Do via Microsoft Graph (`/me/todo`). Apple Reminders has no web API |
| WhatsApp integration | Not started. The only official route is the WhatsApp Business Platform (Cloud API). It needs a Meta business account, outbound messages outside a 24 h window must use pre-approved templates, and group support is limited. Check current availability before committing |
| Messages (iMessage/SMS) | Not started. Apple has no public API for sending iMessages; Apple Messages for Business only covers business-to-customer chat. SMS would need a provider such as Twilio |
| Karo's integration approach | Waiting on details from Karo |
