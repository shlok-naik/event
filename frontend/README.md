# Gather – frontend

Mobile-first React + TypeScript UI (Vite) for the group-based event and messaging app. WhatsApp-inspired:
groups are the home screen, every group is a chat, and events are interactive messages you can join in one tap.

```bash
cd frontend
npm install
npm run dev            # http://localhost:5173 – runs on built-in demo data, no backend needed
npm run build          # type-check + production build
npm run e2e            # Playwright journeys (needs `npm run dev` running); see e2e/
```

## Demo mode vs the real backend

| | |
|---|---|
| **mock** (default) | `VITE_API_MODE=mock`. An in-memory backend (`src/api/mock.ts`) with seeded groups/events/chats, capacity limits, task claiming, unread counts, expiry and simulated friend replies. State persists across reloads (localStorage); **Reset demo data** is on the login screen. Demo login: `alice@example.com` / `password123`. Guest invite link: `/join/guest-demo`. |
| **http** | `VITE_API_MODE=http`. Talks to the REST + WebSocket API (see `backend/docs/API.md` and `src/api/types.ts`). The dev server proxies `/api`, `/uploads` and `/ws` to `VITE_BACKEND_URL` (default `http://localhost:4000`). |

Both implement the same `Api` interface (`src/api/api.ts`), so screens never know which one they use. If the real
backend differs from `src/api/types.ts`, only `src/api/http.ts` needs to change.

`.env.example` lists the settings. `VITE_GOOGLE_MAPS_API_KEY` (browser key, restrict by HTTP referrer) enables the interactive
Google map; without it a simplified pin map is shown. Place **search** goes through the backend (`/api/maps/search`), so no search key is exposed.

## What's in it

* **Auth:** login, sign-up, email-invitation landing page `/join/:token` (join as a guest with just a name, or log in if the email already has an account). Guests can chat, join events and claim tasks only in groups they were invited to; create-group / create-event buttons are hidden for them and the screens show a "registered accounts only" prompt. A guest can **create an account from Profile without losing anything**.
* **Home:** upcoming events carousel, your outstanding tasks, group list with unread badges, "+" to create a group or event (registered users).
* **Groups:** create (name, image, location search, many emails at once), info screen (members, map, invite more, leave), map of authorised groups.
* **Chat:** bubbles with sender names and times, day separators, event messages with a Join button, pinned upcoming events strip that scrolls horizontally, live updates over WebSocket, read tracking.
* **Events:** create (name, description, Google location, date/time, min, optional max, tasks/things to bring with quick-add chips, send to several groups), detail page (map, count, min/max, attendees, claim / release / tick tasks, "enough people joined" and "all tasks assigned" indicators, cancel).
* **Tasks & alerts:** personal task list grouped by event with deadlines, notification list, reminder settings including the **beta smart reminders** toggle.
* **Lifecycle:** ended events disappear (home, pinned strip, chat cards, task lists) on their own via a clock tick and on server `event.deleted` pushes; old links show "no longer available".
* **States:** loading skeletons, empty states, error states with retry, toasts, form validation.
* **Design system:** tokens + components in `src/styles.css`, `src/components/ui.tsx` (Button, Avatar, Tag, Field, Toggle, Stepper, Sheet, TopBar, states). Light/dark automatic. Desktop gets a two-pane layout (chat list left, content right); phones get a bottom nav.

## Layout

```
src/api/        Api interface, http client, mock backend, shared types (types.ts = copy of backend/src/api-types.ts)
src/lib/        auth, realtime → query-cache bridge, react-query hooks, formatting, lifecycle rules, toasts
src/components/ ui kit, Shell (sidebar / bottom nav), EventBits (join button, cards), MapView, LocationPicker, TaskRow…
src/pages/      Auth, Home, Chat, Groups, Events, Me (tasks, alerts, profile, connections)
e2e/            mock.e2e.cjs · guest.e2e.cjs · http.e2e.cjs (against the real backend)
```

## Testing status

Run in headless Chromium at phone (390×844) and desktop (1280×800) sizes: registered and guest journeys against the mock API
(`npm run e2e`), and a full journey against the real backend (`e2e/http.e2e.cjs`: sign-up, group + email invite, event, guest join
from the emailed link, live chat between two browsers, RSVP/claim, guest upgrade, unread badge, cancel).

**Not verified:** the live Google Maps map and Places search (no API key here – only the fallback map and mocked places were exercised),
real phones/Safari, screen-reader behaviour beyond roles/labels, and push notifications.

## Notes / assumptions

* "Connections" (calendar, to-dos, WhatsApp, Messages) is an **interface preview only**: toggles show "coming soon". Nothing is connected and no Karo-style integration has been researched or built.
* Event end time isn't asked for in the form (kept to the minimum clicks); the backend treats events as ending 3 h after the start.
* There's no event-edit screen yet (the API supports it); creators can cancel and add tasks.
* The UI assumes the guest/registered rules from the backend docs (only registered users create groups/events).
