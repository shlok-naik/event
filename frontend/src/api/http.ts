import { ApiError, type Api } from './api';
import type { ServerWsMessage } from './types';

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

let token: string | null = null;
export const setHttpToken = (t: string | null) => { token = t; };

async function call<T>(method: string, path: string, body?: unknown, raw?: BodyInit, contentType?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : contentType ? { 'Content-Type': contentType } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'network_error', "Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}
const get = <T>(p: string) => call<T>('GET', p);
const post = <T>(p: string, b: unknown = {}) => call<T>('POST', p, b);

export const httpApi: Api = {
  auth: {
    register: (i) => post('/auth/register', i),
    login: (i) => post('/auth/login', i),
    logout: () => post('/auth/logout'),
    me: () => get('/auth/me'),
    upgrade: (i) => post('/auth/upgrade', i),
  },
  invitations: {
    preview: (t) => get(`/invitations/${encodeURIComponent(t)}`),
    accept: (t, displayName) => post('/invitations/accept', { token: t, ...(displayName ? { displayName } : {}) }),
  },
  groups: {
    list: () => get('/groups'),
    get: (id) => get(`/groups/${id}`),
    async create(i) {
      const g = await post<{ id: string }>('/groups', { name: i.name, location: i.location });
      if (i.image) {
        const up = await call<{ imageUrl: string }>('POST', `/groups/${g.id}/image`, undefined, i.image, i.image.type || 'application/octet-stream');
        await call('PATCH', `/groups/${g.id}`, { imageUrl: up.imageUrl });
      }
      if (i.emails.length) await post(`/groups/${g.id}/invitations`, { emails: i.emails });
      return get(`/groups/${g.id}`);
    },
    members: (id) => get(`/groups/${id}/members`),
    locations: () => get('/groups/locations'),
    invite: async (id, emails) => (await post<{ results: { email: string; result: string }[] }>(`/groups/${id}/invitations`, { emails })).results,
    leave: (g, me) => call('DELETE', `/groups/${g}/members/${me}`),
    messages: (id, before) => get(`/groups/${id}/messages?limit=100${before ? `&before=${before}` : ''}`),
    send: (id, body) => post(`/groups/${id}/messages`, { body }),
    markRead: (id) => post(`/groups/${id}/read`),
    pinned: (id) => get(`/groups/${id}/pinned-events`),
  },
  events: {
    list: () => get('/events?scope=upcoming'),
    get: (id) => get(`/events/${id}`),
    create: (i) => post('/events', i),
    cancel: (id) => post(`/events/${id}/cancel`),
    rsvp: (id) => call('PUT', `/events/${id}/rsvp`, {}),
    withdraw: (id) => call('DELETE', `/events/${id}/rsvp`),
    addTask: (id, title) => post(`/events/${id}/tasks`, { title }),
  },
  tasks: {
    mine: () => get('/tasks/mine'),
    claim: (id) => post(`/tasks/${id}/claim`),
    unclaim: (id) => post(`/tasks/${id}/unclaim`),
    complete: (id) => post(`/tasks/${id}/complete`),
    uncomplete: (id) => post(`/tasks/${id}/uncomplete`),
  },
  notifications: {
    list: () => get('/notifications'),
    markRead: (id) => post(`/notifications/${id}/read`),
    markAllRead: () => post('/notifications/read-all'),
    getPrefs: () => get('/notifications/preferences'),
    setPrefs: (p) => call('PUT', '/notifications/preferences', p),
  },
  maps: { search: (q) => get(`/maps/search?q=${encodeURIComponent(q)}`) },
  realtime: {
    connect(tok, handler) {
      let ws: WebSocket | null = null;
      let closed = false;
      let retry = 1000;
      const open = () => {
        const base = BASE ? BASE.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
        ws = new WebSocket(`${base}/ws`);
        ws.onopen = () => { retry = 1000; ws!.send(JSON.stringify({ type: 'auth', token: tok })); };
        ws.onmessage = (e) => { try { handler(JSON.parse(e.data) as ServerWsMessage); } catch { /* ignore */ } };
        ws.onclose = () => { if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 15000))); };
      };
      open();
      return () => { closed = true; ws?.close(); };
    },
  },
};
