# Event App API

Base URL (dev): `http://localhost:8000`. Interactive docs: `/docs` (Swagger) and `/redoc`.
The machine-readable schema with **every shared data type** is in [`openapi.json`](openapi.json).
Regenerate it with `python scripts/export_openapi.py` after changing endpoints or schemas.

## Conventions

- **Auth**: `Authorization: Bearer <token>`. Tokens come from register/login (users) or
  invitation/magic-link (guests). The same header works for both kinds of session.
- **Times**: ISO 8601 with a timezone (`2026-12-01T18:00:00Z`). Times without a timezone are rejected.
- **IDs**: UUID strings. Message ids are integers, so they can be ordered.
- **Errors**: always `{"error": {"code": "...", "message": "..."}}`. Validation errors (422) also include
  `details: [{loc, message}]`. Resources you are not allowed to see return **404**, not 403.
- **Rate limits**: 429 `rate_limited`. Global limit is 600 req/min per IP. Tighter per-endpoint limits are listed below.

### Error codes the UI should handle

| Code | Status | When |
|---|---|---|
| `email_taken` | 409 | register, or a guest upgrading to an email that already has an account |
| `guest_upgrade_required` | 409 | register with an email that already has guest access. The guest should request a magic link and upgrade instead |
| `invalid_credentials` | 401 | login |
| `invalid_session` | 401 | the token is expired, revoked, or belongs to a guest who has upgraded |
| `registration_required` | 403 | a guest tried to create a group, create an event or send invitations |
| `login_required` | 401 | an invitation belongs to a registered email. Log in as that account and retry |
| `invalid_invitation` / `invalid_link` | 404 / 401 | the invitation or magic link is used, revoked or expired |
| `already_participating` / `not_participating` | 409 | RSVP / withdraw |
| `event_full`, `event_cancelled`, `event_started` | 409 | RSVP |
| `max_below_participants` | 409 | the event edit would set max below the current participant count |
| `task_already_claimed`, `task_not_claimed`, `task_already_completed` | 409 | task actions |
| `maps_not_configured` | 503 | no `GOOGLE_MAPS_API_KEY` is set on the server |

## Permissions summary

| Action | Who |
|---|---|
| Create groups, create events, send invitations | Registered users only. Inviting also requires group membership |
| See a group, its messages, members and location; post messages | Members (users and guests) |
| Edit a group, upload its image, list or revoke invitations, pin events | Group owner or admin |
| Delete a group, change roles | Owner |
| See member emails | Owner and admins. Everyone else sees display names only |
| See an event, its participants and its tasks | Members of at least one group the event is shared to |
| Edit, cancel or share an event; create, edit or delete tasks | The event creator |
| RSVP | Members of the event's groups, while the event is active and has not started |
| Claim a task | Event participants (people who have RSVP'd) |
| Unclaim a task | The assignee, or the event creator |
| Complete a task | The assignee |

## Endpoints

### Auth (`/auth`)
| Method | Path | Body → Response | Notes |
|---|---|---|---|
| POST | `/auth/register` | `RegisterIn` → `SessionOut` (201) | 10/hour/IP |
| POST | `/auth/login` | `LoginIn` → `SessionOut` | 10/min/IP |
| POST | `/auth/logout` | → `OkOut` | revokes the current token |
| GET | `/auth/me` | → `MeOut` | `type` is `"user"` or `"guest"` |
| PATCH | `/auth/me` | `{display_name}` → `MeOut` | |
| POST | `/auth/guest/magic-link` | `{email}` → 202 | emails a one-time sign-in link to an existing guest. Always 202. 5 per 10 min |
| POST | `/auth/guest/session` | `{token}` → `SessionOut` | exchanges the magic-link token (single use, 30 min) |
| POST | `/auth/guest/upgrade` | `{password, display_name?}` → `SessionOut` | **guest session only**. Keeps every membership, message, RSVP, task, notification and preference. Replace the stored token with the returned one |

Frontend routes used in emails: `{FRONTEND_BASE_URL}/invite?token=…` and `{FRONTEND_BASE_URL}/guest-login?token=…`.

### Invitations
| Method | Path | Notes |
|---|---|---|
| POST | `/groups/{id}/invitations` | `{emails: [...]}`, up to 50 at once. Returns `{invited: InvitationOut[], already_members: string[]}`. Re-inviting an email revokes its older link |
| GET | `/groups/{id}/invitations` | pending invitations (admin) |
| DELETE | `/groups/{id}/invitations/{invId}` | revoke (admin) |
| POST | `/invitations/preview` | `{token}` → `InvitationPreviewOut` (group name, inviter, `requires_login`) |
| POST | `/invitations/accept` | `{token, display_name?}` → `{group_id, session}`. Guests get `session` (store `session.token`). Registered emails need the bearer header of that account |
| POST | `/invitations/{invId}/accept` | accept from an in-app `group_invite` notification (`data.invitation_id`) |

### Groups
| Method | Path | Notes |
|---|---|---|
| GET | `/groups` | your groups with `unread_count`, `member_count` and `last_message_at`. Most recently active first |
| POST | `/groups` | `GroupCreateIn` (name, description, image_url (https), location) |
| GET | `/groups/locations` | map pins for **your** groups only |
| GET/PATCH/DELETE | `/groups/{id}` | deleting a group also deletes events shared only to it |
| POST | `/groups/{id}/image` | multipart `file`. PNG, JPEG, GIF or WebP, up to 2 MB. Served at `image_url` (`/media/...`) |
| GET | `/groups/{id}/members` | `MemberOut[]` |
| PATCH | `/groups/{id}/members/{membershipId}` | `{role: owner\|admin\|member}` (owner only) |
| DELETE | `/groups/{id}/members/{membershipId}` | remove someone, or leave using your own membership id |

### Messages
| Method | Path | Notes |
|---|---|---|
| GET | `/groups/{id}/messages?limit=50&before_id=` | `{messages (oldest→newest), has_more}`. To page back, pass the oldest id you hold |
| POST | `/groups/{id}/messages` | `{body}` (1–4000 chars). 30/min per session |
| POST | `/groups/{id}/read` | `{message_id}` → `{unread_count}`. The read position never moves backwards |
| GET | `/groups/{id}/pinned-events` | upcoming, active, pinned `EventSummary[]`, soonest first |

`MessageOut.kind`:
- `text`: a normal message.
- `system`: e.g. "X joined the group". `sender` is null.
- `event`: an interactive event card. `event` is a live `EventSummary` with counts and `my_rsvp`, so render the RSVP button from it.
- `event_expired`: the event has ended and been removed. Show it as plain text.

### Events
| Method | Path | Notes |
|---|---|---|
| POST | `/events` | `EventCreateIn` with `group_ids[]`. Registered users only, and you must be in every group. Posts an event card to each group, pins the event and notifies members |
| GET | `/events?group_id=&include_cancelled=` | upcoming events you can see |
| GET | `/events/{id}` | `EventOut`. `group_ids` lists only the groups you are in |
| PATCH | `/events/{id}` | creator only. Participants receive an `event_updated` notification with `data.changed` |
| POST | `/events/{id}/cancel` | creator only. Notifies participants, unpins the event and cancels reminders |
| POST | `/events/{id}/share` | `{group_ids}`: shares to more groups, with the **same** participants and tasks |
| POST | `/events/{id}/pin` | `{group_id, pinned}` (group admin) |
| GET | `/events/{id}/ics` | `.ics` calendar file (calendar sync) |

### RSVPs
| Method | Path | Notes |
|---|---|---|
| GET | `/events/{id}/participants` | `ParticipantOut[]` |
| GET | `/events/{id}/rsvp` | `RSVPStateOut` (`participating`, counts, `min_reached`, `is_full`) |
| POST | `/events/{id}/rsvp` | join. Safe under concurrency: never exceeds `max_participants` and never double-counts |
| DELETE | `/events/{id}/rsvp` | withdraw. Unfinished tasks you had claimed go back to `open` |

### Tasks
| Method | Path | Notes |
|---|---|---|
| GET | `/events/{id}/tasks` | `TaskOut[]` (`status`: open, claimed or completed, plus `assignee`) |
| POST | `/events/{id}/tasks` | creator only |
| PATCH/DELETE | `/events/{id}/tasks/{taskId}` | creator only |
| POST | `/events/{id}/tasks/{taskId}/claim` | participants. Only one claim can win (409 for the others) |
| POST | `/events/{id}/tasks/{taskId}/unclaim` | assignee or creator |
| POST | `/events/{id}/tasks/{taskId}/complete` | assignee |
| GET | `/me/tasks` | your outstanding (claimed, not completed) tasks, soonest event first |

`EventOut.task_counts` gives `{open, claimed, completed}`.

### Notifications
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?unread_only=&before=&limit=` | newest first |
| POST | `/notifications/read` | `{ids?}`. Omit `ids` to mark everything read |
| GET/PATCH | `/notifications/preferences` | per-kind toggles plus `push_enabled`, `email_enabled` and `reminder_lead_hours` (1–168) |

Notification `kind` values: `group_invite`, `new_event`, `event_updated`, `event_cancelled`,
`min_participants_reached`, `event_reminder`, `task_reminder`, `smart_reminder`.
When a category is turned off, the backend creates no notification of that kind at all: nothing in-app, no push, no email.

### Locations (Google Maps proxy, 60/min per session)
| Method | Path | Notes |
|---|---|---|
| GET | `/locations/search?q=&lat=&lng=` | Places text search, optionally biased near `lat`/`lng` |
| GET | `/locations/geocode?address=` | address → coordinates |
| GET | `/locations/reverse?lat=&lng=` | coordinates → address |

All three return `PlaceOut[] {place_id, name, address, latitude, longitude}`. Pass the chosen
place back as `location` when creating a group or event. The API key stays on the server.

## Realtime (WebSocket `/ws`)

```js
const ws = new WebSocket("ws://localhost:8000/ws");
ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
ws.onmessage = (e) => handle(JSON.parse(e.data));
```

You must authenticate within 10 seconds, or the socket closes with code `4401`. The token never goes in the URL.
Send `{"type":"ping"}` and the server answers `{"type":"pong"}`.

| Event `type` | Payload | Suggested client action |
|---|---|---|
| `ready` | `principal` | — |
| `message.created` | `message: MessageOut` | append to the chat. `event.my_rsvp` is always false here, so refetch the event for your own state |
| `event.created` / `event.updated` / `event.cancelled` | `event_id`, `changed?` | refetch the event and pinned events |
| `event.deleted` | `event_ids` | drop those events from local state |
| `rsvp.changed` | `event_id`, counts, `min_reached`, `is_full` | update counters live |
| `task.changed` | `event_id`, `task_ids` | refetch tasks |
| `notification.created` | `notification: NotificationOut` | badge or toast |
| `group.updated` / `group.deleted` / `group.removed` | `group_id` | refetch or remove the group |

Events are sent only after the database transaction commits. Realtime runs in a single process; see the README to scale out.

## Notification API contract (for Kyrill)

With `NOTIFICATION_BACKEND=webhook`, each notification is POSTed to `NOTIFICATION_WEBHOOK_URL`
with `Authorization: Bearer $NOTIFICATION_API_KEY`:

```json
{
  "id": "uuid",
  "recipient": {"type": "user", "id": "uuid"},
  "kind": "event_reminder",
  "title": "Coming up: Picnic",
  "body": "Starts Tue 01 Dec, 18:00 UTC",
  "data": {"event_id": "uuid"},
  "group_id": null,
  "event_id": "uuid",
  "created_at": "2026-11-30T18:00:00Z",
  "read_at": null
}
```

Any 2xx response marks the notification as delivered. Failures are retried each scheduler tick for 24 hours.
Pushes go only to recipients with `push_enabled`. If the notification service needs device tokens,
we can add a `POST /devices` endpoint; tell us what format it expects.

## Reminders

- **Upcoming event**: sent `reminder_lead_hours` (default 24) before the event to everyone who RSVP'd.
- **Smart reminders (beta)**, worked out every scheduler tick:
  - People holding unfinished tasks are reminded at 24 h and 3 h before the event (`task_reminder`).
  - When tasks are still unclaimed, participants are nudged at 24 h and 6 h. The nudge is marked "Urgent" when the event is under 6 h away and fewer than half the tasks are done.
  - When the minimum number of participants hasn't been reached, group members who haven't joined are nudged at 48 h and 12 h.
- Each reminder is sent at most once. Reminders are cancelled when the event is cancelled and deleted when the event is deleted.

## Automatic event deletion

An event expires at its `ends_at`, or at `starts_at` + `EVENT_DEFAULT_DURATION_HOURS` if there is no end time, plus `EVENT_DELETE_GRACE_HOURS`.

- From that moment, every endpoint treats the event as not found. Its chat cards show as `event_expired`, and it disappears from pinned events and from `/me/tasks`.
- The scheduler then hard-deletes the event with its RSVPs, tasks, assignments, pinned links, reminders and notifications, and sends `event.deleted`.
