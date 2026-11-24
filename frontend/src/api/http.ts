/* Adapter between the UI and the FastAPI backend (backend/docs/API.md).
   The backend speaks snake_case with slightly different shapes; everything is translated here so
   screens only deal with the view-model types in ./types. */
import { ApiError, type Api, type RealtimeEvent } from './api';
import type {
  AuthResponse, EventDetail, EventSummary, Group, GroupMember, Location, Me, Message, Notification, NotificationPreferences,
  NotificationType, OutstandingTask, PublicProfile, Task,
} from './types';

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
/** Same-origin `/api` by default (the dev server / reverse proxy strips the prefix); VITE_API_URL points straight at the backend. */
const API = BASE || '/api';
let token: string | null = null;
export const setHttpToken = (t: string | null) => { token = t; };

async function call<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'network_error', "Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}
const get = <T>(p: string) => call<T>('GET', p);
const post = <T>(p: string, b: unknown = {}) => call<T>('POST', p, b);

/* ---------- backend → view-model ---------- */
const actor = (a: any): PublicProfile | null => (a ? { id: a.id, displayName: a.display_name, kind: a.type } : null);
const me = (m: any): Me => ({ id: m.id, displayName: m.display_name, kind: m.type, email: m.email ?? null });
const auth = (s: any): AuthResponse => ({ token: s.token, expiresAt: new Date(Date.now() + (s.expires_in_days ?? 30) * 864e5).toISOString(), me: me(s.principal) });
const loc = (l: any): Location | null => (l && l.latitude != null && l.longitude != null ? { name: l.name ?? null, address: l.address ?? null, placeId: l.place_id ?? null, lat: l.latitude, lng: l.longitude } : null);
const locIn = (l: Location | null) => (l ? { name: l.name, address: l.address, place_id: l.placeId, latitude: l.lat, longitude: l.lng } : null);
const img = (u: string | null) => (u && u.startsWith('/') ? `${API}${u}` : u);

const taskStatus = { open: 'unassigned', claimed: 'assigned', completed: 'completed' } as const;
const task = (t: any): Task => ({
  id: t.id, eventId: t.event_id, title: t.title, description: t.description ?? '', status: taskStatus[t.status as keyof typeof taskStatus] ?? 'unassigned',
  assignee: actor(t.assignee), claimedAt: t.claimed_at, completedAt: t.completed_at, createdAt: t.created_at,
});

const NO_CREATOR: PublicProfile = { id: '', displayName: '', kind: 'user' };
/** Works for both EventOut and the lighter EventSummary (embedded in messages / pinned lists). */
const event = (e: any): EventSummary => {
  const c = e.task_counts;
  return {
    id: e.id, name: e.name, description: e.description ?? '', location: loc(e.location), startsAt: e.starts_at, endsAt: e.ends_at,
    status: e.status === 'cancelled' ? 'cancelled' : 'active', minParticipants: e.min_participants, maxParticipants: e.max_participants,
    goingCount: e.participant_count, minimumMet: e.min_reached, full: e.is_full, creator: actor(e.creator) ?? NO_CREATOR, groupIds: e.group_ids ?? [],
    taskCounts: c ? { total: c.open + c.claimed + c.completed, unassigned: c.open, assigned: c.claimed, completed: c.completed } : { total: 0, unassigned: 0, assigned: 0, completed: 0 },
    myRsvp: e.my_rsvp ? 'going' : 'not_going',
  };
};
const message = (m: any): Message => ({
  id: m.id, groupId: m.group_id, sender: actor(m.sender), type: m.kind === 'text' ? 'text' : m.kind === 'event' ? 'event' : 'system',
  body: m.body, createdAt: m.created_at, ...(m.kind === 'event' && m.event ? { event: event(m.event) } : {}),
});
const group = (g: any, last: Message | null = null): Group => ({
  id: g.id, name: g.name, imageUrl: img(g.image_url), location: loc(g.location), myRole: g.my_role, memberCount: g.member_count,
  unreadCount: g.unread_count, lastMessage: last, createdAt: g.created_at,
});
const KIND: Record<string, NotificationType> = { min_participants_reached: 'event_min_met' };
const notification = (n: any): Notification => ({
  id: n.id, type: (KIND[n.kind] ?? n.kind) as NotificationType, title: n.title, body: n.body, eventId: n.event_id, groupId: n.group_id, createdAt: n.created_at, readAt: n.read_at,
});
const prefs = (p: any): NotificationPreferences => ({
  groupInvites: p.group_invites, newEvents: p.new_events, eventReminders: p.event_reminders, taskReminders: p.task_reminders,
  eventChanges: p.event_updates, smartReminders: p.smart_reminders, pushEnabled: p.push_enabled, emailEnabled: p.email_enabled, reminderLeadHours: p.reminder_lead_hours,
});
const prefsIn = (p: Partial<NotificationPreferences>) => ({
  group_invites: p.groupInvites, new_events: p.newEvents, event_reminders: p.eventReminders, task_reminders: p.taskReminders,
  event_updates: p.eventChanges, smart_reminders: p.smartReminders, push_enabled: p.pushEnabled, email_enabled: p.emailEnabled, reminder_lead_hours: p.reminderLeadHours,
});

async function eventDetail(id: string): Promise<EventDetail> {
  const [e, parts, tasks] = await Promise.all([get<any>(`/events/${id}`), get<any[]>(`/events/${id}/participants`), get<any[]>(`/events/${id}/tasks`)]);
  return { ...event(e), participants: parts.map((p) => ({ ...actor(p.actor)!, rsvpAt: p.rsvp_at })), tasks: tasks.map(task), isCreator: !!e.is_creator };
}

export const httpApi: Api = {
  auth: {
    register: async (i) => auth(await post('/auth/register', { email: i.email, password: i.password, display_name: i.displayName })),
    login: async (i) => auth(await post('/auth/login', i)),
    logout: async () => { await post('/auth/logout'); },
    me: async () => me(await get('/auth/me')),
    upgrade: async (i) => auth(await post('/auth/guest/upgrade', { password: i.password, display_name: i.displayName })),
    guestSession: async (t) => auth(await post('/auth/guest/session', { token: t })),
    requestGuestLink: async (email) => { await post('/auth/guest/magic-link', { email }); },
  },
  invitations: {
    async preview(t) {
      const p = await post<any>('/invitations/preview', { token: t });
      return { groupName: p.group_name, groupImageUrl: null, invitedBy: p.invited_by ?? 'Someone', email: p.email, loginRequired: p.requires_login, expired: Date.parse(p.expires_at) < Date.now() };
    },
    async accept(t, displayName) {
      const r = await post<any>('/invitations/accept', { token: t, ...(displayName ? { display_name: displayName } : {}) });
      const a = r.session ? auth(r.session) : undefined;
      if (a) token = a.token;                      // guests: use the new session straight away
      return { group: group(await get(`/groups/${r.group_id}`)), ...(a ? { auth: a } : {}) };
    },
  },
  groups: {
    async list() {
      const gs = await get<any[]>('/groups');
      // the list only carries last_message_at; fetch the latest message per group for the preview line
      const last = await Promise.all(gs.map((g) => (g.last_message_at ? get<any>(`/groups/${g.id}/messages?limit=1`).then((r) => (r.messages[0] ? message(r.messages[0]) : null)).catch(() => null) : null)));
      return gs.map((g, i) => group(g, last[i]));
    },
    get: async (id) => group(await get(`/groups/${id}`)),
    async create(i) {
      let g = await post<any>('/groups', { name: i.name, location: locIn(i.location) });
      if (i.image) { const f = new FormData(); f.append('file', i.image); g = await call<any>('POST', `/groups/${g.id}/image`, undefined, f); }
      if (i.emails.length) await post(`/groups/${g.id}/invitations`, { emails: i.emails });
      return group(g);
    },
    async members(id) {
      return (await get<any[]>(`/groups/${id}/members`)).map((m): GroupMember => ({ ...actor(m.actor)!, role: m.role, joinedAt: m.joined_at, ...(m.email ? { email: m.email } : {}) }));
    },
    async locations() {
      return (await get<any[]>('/groups/locations')).map((l) => ({ groupId: l.group_id, name: l.name, imageUrl: null, location: loc(l.location)! })).filter((l) => l.location);
    },
    async invite(id, emails) {
      const r = await post<any>(`/groups/${id}/invitations`, { emails });
      return [...r.invited.map((i: any) => ({ email: i.email, result: 'sent' })), ...r.already_members.map((email: string) => ({ email, result: 'already_member' }))];
    },
    async leave(groupId, myId) {
      const m = (await get<any[]>(`/groups/${groupId}/members`)).find((x) => x.actor.id === myId);
      if (m) await call('DELETE', `/groups/${groupId}/members/${m.membership_id}`);
    },
    async messages(id, before) {
      const r = await get<any>(`/groups/${id}/messages?limit=100${before ? `&before_id=${before}` : ''}`);
      return { messages: r.messages.map(message), hasMore: r.has_more };
    },
    send: async (id, body) => message(await post(`/groups/${id}/messages`, { body })),
    markRead: async (id, upTo) => { await post(`/groups/${id}/read`, { message_id: upTo }); },
    pinned: async (id) => (await get<any[]>(`/groups/${id}/pinned-events`)).map(event),
  },
  events: {
    list: async () => (await get<any[]>('/events')).map(event),
    get: eventDetail,
    async create(i) {
      const e = await post<any>('/events', {
        name: i.name, description: i.description || null, location: locIn(i.location), starts_at: i.startsAt, ends_at: i.endsAt ?? null,
        min_participants: i.minParticipants, max_participants: i.maxParticipants, group_ids: i.groupIds,
      });
      for (const t of i.tasks) await post(`/events/${e.id}/tasks`, { title: t.title });
      await post(`/events/${e.id}/rsvp`).catch(() => undefined);   // the organiser attends by default (the backend doesn't do this itself)
      return eventDetail(e.id);
    },
    cancel: async (id) => { await post(`/events/${id}/cancel`); return eventDetail(id); },
    rsvp: async (id) => { await post(`/events/${id}/rsvp`); return eventDetail(id); },
    withdraw: async (id) => { await call('DELETE', `/events/${id}/rsvp`); return eventDetail(id); },
    addTask: async (eventId, title) => task(await post(`/events/${eventId}/tasks`, { title })),
  },
  tasks: {
    async mine() {
      return (await get<any[]>('/me/tasks')).map((t): OutstandingTask => ({ ...task(t), event: { id: t.event_id, name: t.event_name, startsAt: t.event_starts_at, status: 'active' } }));
    },
    claim: async (e, t) => task(await post(`/events/${e}/tasks/${t}/claim`)),
    unclaim: async (e, t) => task(await post(`/events/${e}/tasks/${t}/unclaim`)),
    complete: async (e, t) => task(await post(`/events/${e}/tasks/${t}/complete`)),
  },
  notifications: {
    async list() { const l = (await get<any[]>('/notifications?limit=50')).map(notification); return { notifications: l, unreadCount: l.filter((n) => !n.readAt).length }; },
    markRead: async (id) => { await post('/notifications/read', { ids: [id] }); },
    markAllRead: async () => { await post('/notifications/read', {}); },
    getPrefs: async () => prefs(await get('/notifications/preferences')),
    setPrefs: async (p) => prefs(await call('PATCH', '/notifications/preferences', prefsIn(p))),
  },
  maps: {
    async search(q) {
      return (await get<any[]>(`/locations/search?q=${encodeURIComponent(q)}`)).filter((p) => p.latitude != null).map((p) => ({ placeId: p.place_id, name: p.name, address: p.address, lat: p.latitude, lng: p.longitude }));
    },
  },
  realtime: {
    connect(tok, handler) {
      let ws: WebSocket | null = null; let closed = false; let retry = 1000;
      const translate = (m: any): RealtimeEvent | null => {
        switch (m.type) {
          case 'message.created': return { type: 'message.new', message: message(m.message) };
          case 'event.created': case 'event.updated': case 'event.cancelled': return { type: 'event.changed', eventId: m.event_id };
          case 'event.deleted': return { type: 'event.deleted', eventIds: m.event_ids };
          case 'rsvp.changed': return { type: 'rsvp.changed', eventId: m.event_id, goingCount: m.participant_count, minimumMet: m.min_reached, full: m.is_full };
          case 'task.changed': return { type: 'task.changed', eventId: m.event_id };
          case 'notification.created': return { type: 'notification.new', notification: notification(m.notification) };
          case 'group.updated': return { type: 'group.changed', groupId: m.group_id };
          case 'group.deleted': case 'group.removed': return { type: 'group.removed', groupId: m.group_id };
          default: return null;
        }
      };
      const open = () => {
        const base = BASE ? BASE.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api`;
        ws = new WebSocket(`${base}/ws`);
        ws.onopen = () => { retry = 1000; ws!.send(JSON.stringify({ type: 'auth', token: tok })); };
        ws.onmessage = (e) => { try { const r = translate(JSON.parse(e.data)); if (r) handler(r); } catch { /* ignore malformed */ } };
        ws.onclose = (e) => { if (!closed && e.code !== 4401) setTimeout(open, (retry = Math.min(retry * 2, 15000))); };
      };
      open();
      return () => { closed = true; ws?.close(); };
    },
  },
};
