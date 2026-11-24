/* In-memory demo backend that mimics the real API's behaviour (permissions, capacity, tasks, unread,
   expiry). Lets the whole UI be built and tested without a server. State lives for the page session. */
import { ApiError, type Api, type CreateEventInput } from './api';
import type {
  AuthResponse, EventDetail, EventSummary, Group, GroupMember, GroupRole, Location, Me, Message, Notification,
  NotificationPreferences, PlaceResult, PublicProfile, ServerWsMessage, Task,
} from './types';

const H = 3_600_000, M = 60_000;
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms = 140) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

interface User { id: string; kind: 'user' | 'guest'; email: string | null; password?: string; displayName: string }
interface MGroup { id: string; name: string; imageUrl: string | null; location: Location | null; createdAt: string; members: Map<string, { role: GroupRole; lastRead: number; joinedAt: string }> }
interface MTask { id: string; title: string; assignee: string | null; claimedAt: string | null; completedAt: string | null; createdAt: string }
interface MEvent {
  id: string; creator: string; name: string; description: string; location: Location | null; startsAt: string; endsAt: string | null;
  min: number; max: number | null; groupIds: string[]; status: 'active' | 'cancelled'; going: Map<string, string>; tasks: MTask[];
}
interface MMsg { id: number; groupId: string; sender: string | null; type: Message['type']; body: string; eventId: string | null; createdAt: string }

const RETENTION = 30 * M, DEFAULT_LEN = 3 * H;
const endOf = (e: { startsAt: string; endsAt: string | null }) => (e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + DEFAULT_LEN);

export const MOCK_PLACES: PlaceResult[] = [
  { placeId: 'p1', name: 'Mile End Climbing Wall', address: '2 Haverfield Rd, London E3 5BE', lat: 51.5272, lng: -0.0334 },
  { placeId: 'p2', name: 'Victoria Park', address: 'Grove Rd, London E3 5TB', lat: 51.5362, lng: -0.0402 },
  { placeId: 'p3', name: 'The Book Nook Café', address: '12 Camden High St, London NW1 0JH', lat: 51.5392, lng: -0.1426 },
  { placeId: 'p4', name: 'Hampstead Heath', address: 'Parliament Hill, London NW5 1QR', lat: 51.5608, lng: -0.1535 },
  { placeId: 'p5', name: 'Borough Market', address: '8 Southwark St, London SE1 1TL', lat: 51.5055, lng: -0.091 },
  { placeId: 'p6', name: 'Brockwell Lido', address: 'Dulwich Rd, London SE24 0PA', lat: 51.4501, lng: -0.1085 },
];

export const resetMockData = () => { try { localStorage.removeItem('gather.mock.v1'); localStorage.removeItem('gather.token'); } catch { /* ignore */ } };

export function createMockApi(): Api {
  const users = new Map<string, User>();
  const sessions = new Map<string, string>();      // token -> user id
  const groups = new Map<string, MGroup>();
  const events = new Map<string, MEvent>();
  const msgs: MMsg[] = [];
  const notifs = new Map<string, (Notification)[]>();
  const prefs = new Map<string, NotificationPreferences>();
  const invites = new Map<string, { groupId: string; email: string; by: string }>();
  let msgSeq = 100;
  let me: string | null = null;
  const handlers = new Set<(m: ServerWsMessage) => void>();
  const push = (m: ServerWsMessage) => handlers.forEach((h) => h(m));

  const mkUser = (u: Omit<User, 'id'>, id = uid()) => { users.set(id, { id, ...u }); return id; };
  const profile = (id: string | null): PublicProfile | null => { const u = id && users.get(id); return u ? { id: u.id, displayName: u.displayName, kind: u.kind } : null; };
  const toMe = (u: User): Me => ({ id: u.id, displayName: u.displayName, kind: u.kind, email: u.email });
  const defaultPrefs = (): NotificationPreferences => ({ groupInvites: true, newEvents: true, eventReminders: true, taskReminders: true, eventChanges: true, smartReminders: true, messages: false, pushEnabled: true, emailEnabled: true });
  const authed = (): User => { const u = me && users.get(me); if (!u) throw new ApiError(401, 'unauthorized', 'Please sign in again'); return u; };
  const needMember = (g: string): MGroup => { const gr = groups.get(g); if (!gr || !gr.members.has(authed().id)) throw new ApiError(404, 'not_found', 'Group not found'); return gr; };
  const live = () => [...events.values()].filter((e) => endOf(e) + RETENTION > Date.now());
  const sees = (e: MEvent, uidv: string) => e.groupIds.some((g) => groups.get(g)?.members.has(uidv));
  const needEvent = (id: string): MEvent => {
    const e = events.get(id);
    if (!e || endOf(e) + RETENTION <= Date.now() || !sees(e, authed().id)) throw new ApiError(404, 'not_found', 'Event not found');
    return e;
  };
  const addNotif = (to: string, n: Omit<Notification, 'id' | 'createdAt' | 'readAt'>) => {
    const full: Notification = { ...n, id: uid(), createdAt: iso(Date.now()), readAt: null };
    notifs.set(to, [full, ...(notifs.get(to) ?? [])]);
    if (to === me) push({ type: 'notification.new', notification: full });
  };

  /* ---------- derived views ---------- */
  const taskDto = (e: MEvent, t: MTask): Task => ({
    id: t.id, eventId: e.id, title: t.title, description: '', status: t.completedAt ? 'completed' : t.assignee ? 'assigned' : 'unassigned',
    assignee: profile(t.assignee), claimedAt: t.claimedAt, completedAt: t.completedAt, createdAt: t.createdAt,
  });
  const summary = (e: MEvent, viewer?: string): EventSummary => {
    const going = e.going.size;
    const tc = { total: e.tasks.length, unassigned: 0, assigned: 0, completed: 0 };
    for (const t of e.tasks) t.completedAt ? tc.completed++ : t.assignee ? tc.assigned++ : tc.unassigned++;
    return {
      id: e.id, name: e.name, description: e.description, location: e.location, startsAt: e.startsAt, endsAt: e.endsAt, status: e.status,
      minParticipants: e.min, maxParticipants: e.max, goingCount: going, minimumMet: going >= e.min, full: e.max != null && going >= e.max,
      creator: profile(e.creator)!, groupIds: e.groupIds.filter((g) => !viewer || groups.get(g)?.members.has(viewer)), taskCounts: tc,
      ...(viewer ? { myRsvp: e.going.has(viewer) ? ('going' as const) : ('not_going' as const) } : {}),
    };
  };
  const detail = (e: MEvent, viewer: string): EventDetail => ({
    ...summary(e, viewer),
    participants: [...e.going].map(([id, at]) => ({ ...profile(id)!, rsvpAt: at })),
    tasks: e.tasks.map((t) => taskDto(e, t)), isCreator: e.creator === viewer,
  });
  const msgDto = (m: MMsg, viewer: string): Message => {
    const ev = m.eventId ? events.get(m.eventId) : null;
    const base: Message = { id: m.id, groupId: m.groupId, sender: profile(m.sender), type: m.type, body: m.body, createdAt: m.createdAt };
    return m.type === 'event' && ev && endOf(ev) + RETENTION > Date.now() ? { ...base, event: summary(ev, viewer) } : base;
  };
  const groupDto = (g: MGroup, viewer: string): Group => {
    const mem = g.members.get(viewer)!;
    const mine = msgs.filter((m) => m.groupId === g.id && !(m.type === 'event' && m.eventId && !events.get(m.eventId)));
    const last = mine.at(-1);
    return {
      id: g.id, name: g.name, imageUrl: g.imageUrl, location: g.location, myRole: mem.role, memberCount: g.members.size,
      unreadCount: mine.filter((m) => m.id > mem.lastRead && m.sender !== viewer).length, lastMessage: last ? msgDto(last, viewer) : null, createdAt: g.createdAt,
    };
  };
  const postMsg = (groupId: string, sender: string | null, type: Message['type'], body: string, eventId: string | null = null, at = Date.now()) => {
    const m: MMsg = { id: ++msgSeq, groupId, sender, type, body, eventId, createdAt: iso(at) };
    msgs.push(m); save();
    const g = groups.get(groupId)!;
    if (me && g.members.has(me)) push({ type: 'message.new', message: msgDto(m, me) });
    return m;
  };
  const broadcastEvent = (e: MEvent) => {
    if (!me) return;
    const s = summary(e, undefined); const gids = e.groupIds.filter((g) => groups.get(g)?.members.has(me!));
    push({ type: 'event.updated', event: { ...s, groupIds: gids }, groupIds: gids });
    push({ type: 'rsvp.changed', eventId: e.id, goingCount: s.goingCount, minimumMet: s.minimumMet, full: s.full, participants: [...e.going].map(([id, at]) => ({ ...profile(id)!, rsvpAt: at })) });
  };

  /* ---------- persistence: survives page reloads (localStorage) ---------- */
  const KEY = 'gather.mock.v1';
  const replacer = (_k: string, v: unknown) => (v instanceof Map ? { __map: [...v] } : v);
  const reviver = (_k: string, v: any) => (v && typeof v === 'object' && v.__map ? new Map(v.__map) : v);
  let restored = false;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw, reviver);
      for (const [k, v] of d.users) users.set(k, v); for (const [k, v] of d.sessions) sessions.set(k, v);
      for (const [k, v] of d.groups) groups.set(k, v); for (const [k, v] of d.events) events.set(k, v);
      msgs.push(...d.msgs); for (const [k, v] of d.notifs) notifs.set(k, v); for (const [k, v] of d.prefs) prefs.set(k, v);
      for (const [k, v] of d.invites) invites.set(k, v);
      msgSeq = d.msgSeq; restored = true;
    }
  } catch { /* corrupted -> reseed */ }
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ users, sessions, groups, events, msgs, notifs, prefs, invites, msgSeq }, replacer)); } catch { /* quota/private mode */ }
  };

  /* ---------- seed data ---------- */
  const mkGroup = (id: string, name: string, owner: string, members: [string, GroupRole?][], location: Location | null, ageH: number): MGroup => {
    const g: MGroup = { id, name, imageUrl: null, location, createdAt: iso(Date.now() - ageH * H), members: new Map() };
    g.members.set(owner, { role: 'owner', lastRead: 0, joinedAt: g.createdAt });
    for (const [m, r] of members) g.members.set(m, { role: r ?? 'member', lastRead: 0, joinedAt: g.createdAt });
    groups.set(id, g); return g;
  };
  const mkEv = (e: Omit<MEvent, 'id' | 'going' | 'status'> & { going: string[] }, id = uid()) => {
    const ev: MEvent = { ...e, id, status: 'active', going: new Map(e.going.map((u) => [u, iso(Date.now() - 3 * H)])) };
    events.set(id, ev); return ev;
  };
  const t = (title: string, assignee: string | null = null, done = false): MTask => ({ id: uid(), title, assignee, claimedAt: assignee ? iso(Date.now() - 2 * H) : null, completedAt: done ? iso(Date.now() - H) : null, createdAt: iso(Date.now() - 5 * H) });
  if (!restored) {
  const alice = mkUser({ kind: 'user', email: 'alice@example.com', password: 'password123', displayName: 'Alice Morgan' }, 'u-alice');
  const bob = mkUser({ kind: 'user', email: 'bob@example.com', password: 'password123', displayName: 'Bob Patel' }, 'u-bob');
  const cara = mkUser({ kind: 'user', email: 'cara@example.com', password: 'password123', displayName: 'Cara Nguyen' }, 'u-cara');
  const dan = mkUser({ kind: 'user', email: 'dan@example.com', password: 'password123', displayName: 'Dan Okoye' }, 'u-dan');
  const loc = (i: number): Location => ({ name: MOCK_PLACES[i]!.name, address: MOCK_PLACES[i]!.address, placeId: MOCK_PLACES[i]!.placeId, lat: MOCK_PLACES[i]!.lat, lng: MOCK_PLACES[i]!.lng });
  mkGroup('g-climb', 'Climbing crew', alice, [[bob], [cara], [dan]], loc(0), 400);
  mkGroup('g-book', 'Book club', alice, [[bob, 'admin'], [cara]], loc(2), 300);
  mkGroup('g-hike', 'Weekend hikers', bob, [[alice], [dan]], loc(3), 200);
  const boulder = mkEv({
    creator: bob, name: 'Bouldering night', description: 'Warm-up at 7, projects after. All levels welcome – shoes can be rented.', location: loc(0),
    startsAt: iso(Date.now() + 2 * 24 * H + 3 * H), endsAt: null, min: 4, max: 8, groupIds: ['g-climb', 'g-book'], going: [bob, cara],
    tasks: [t('Bring chalk', cara), t('Snacks & drinks'), t('Portable speaker'), t('Book the wall', bob, true)],
  }, 'e-boulder');
  mkEv({ creator: alice, name: 'Book swap picnic', description: 'Bring a book you loved, leave with one you will.', location: loc(1), startsAt: iso(Date.now() + 6 * 24 * H), endsAt: null, min: 3, max: null, groupIds: ['g-book'], going: [alice, bob, cara], tasks: [t('Blanket', alice), t('Lemonade')] }, 'e-picnic');
  mkEv({ creator: bob, name: 'Sunday ridge hike', description: '12 km loop, moderate. Lunch at the pub after.', location: loc(3), startsAt: iso(Date.now() + 4 * 24 * H), endsAt: null, min: 3, max: 6, groupIds: ['g-hike'], going: [bob, dan], tasks: [t('First-aid kit'), t('Car share (2 seats)', dan)] }, 'e-hike');
  mkEv({ creator: alice, name: 'Quick coffee', description: 'Short one – this event ends in about two minutes to demo auto-removal.', location: loc(2), startsAt: iso(Date.now() - 20 * M), endsAt: iso(Date.now() + 2 * M), min: 1, max: null, groupIds: ['g-book'], going: [alice], tasks: [t('Order oat milk', alice)] }, 'e-coffee');
  const seed = (g: string, s: string | null, body: string, ago: number, type: Message['type'] = 'text', ev: string | null = null) => {
    msgs.push({ id: ++msgSeq, groupId: g, sender: s, type, body, eventId: ev, createdAt: iso(Date.now() - ago * M) });
  };
  seed('g-climb', bob, 'Who is up for climbing this week? 🧗', 600);
  seed('g-climb', cara, 'Me! Thursday works', 590);
  seed('g-climb', null, 'Bouldering night', 300, 'event', 'e-boulder');
  seed('g-climb', dan, 'I might be late, save me a spot', 45);
  seed('g-climb', cara, "I'll bring the chalk 👍", 12);
  seed('g-book', alice, 'Reminder: finish chapter 9 before the swap!', 900);
  seed('g-book', null, 'Book swap picnic', 800, 'event', 'e-picnic');
  seed('g-book', null, 'Bouldering night', 300, 'event', 'e-boulder');
  seed('g-book', null, 'Quick coffee', 25, 'event', 'e-coffee');
  seed('g-book', bob, 'Coffee anyone?', 18);
  seed('g-hike', bob, 'Route is sorted, see the event 👇', 200);
  seed('g-hike', null, 'Sunday ridge hike', 190, 'event', 'e-hike');
  for (const gid of ['g-climb', 'g-book', 'g-hike']) {   // alice has read most things
    const g = groups.get(gid)!; const last = msgs.filter((m) => m.groupId === gid).at(-1)!.id;
    g.members.get(alice)!.lastRead = gid === 'g-climb' ? last - 2 : last;
  }
  notifs.set(alice, [
    { id: uid(), type: 'event_min_met', title: 'Book swap picnic is on!', body: 'Book swap picnic has reached its minimum of 3 participants', eventId: 'e-picnic', groupId: null, createdAt: iso(Date.now() - 3 * H), readAt: null },
    { id: uid(), type: 'task_reminder', title: 'Task reminder: Blanket', body: 'You still need to do "Blanket" for Book swap picnic', eventId: 'e-picnic', groupId: null, createdAt: iso(Date.now() - 26 * H), readAt: iso(Date.now() - 20 * H) },
  ]);
  void boulder;
  invites.set('guest-demo', { groupId: 'g-hike', email: 'friend@example.com', by: bob });
  invites.set('login-demo', { groupId: 'g-climb', email: 'dan@example.com', by: alice });

  }

  const authResp = (u: User): AuthResponse => {
    const token = `mock-${uid()}${uid()}`; sessions.set(token, u.id); me = u.id;
    return { token, expiresAt: iso(Date.now() + 30 * 24 * H), me: toMe(u) };
  };
  const dupFree = (email: string) => { for (const u of users.values()) if (u.email?.toLowerCase() === email.toLowerCase()) throw new ApiError(409, 'email_taken', 'An account with this email already exists'); };

  /* "friends" react to the user so the demo feels alive */
  const friendReply = (groupId: string, to: string) => {
    const g = groups.get(groupId)!; const friend = [...g.members.keys()].find((m) => m !== to && users.get(m)?.kind === 'user');
    if (!friend) return;
    setTimeout(() => postMsg(groupId, friend, 'text', ['Sounds good!', 'Count me in 🙌', 'Nice one 👍'][Math.floor(Math.random() * 3)]!), 2200);
  };

  const api: Api = {
    auth: {
      async register(i) { await sleep(); dupFree(i.email); const id = mkUser({ kind: 'user', email: i.email, password: i.password, displayName: i.displayName }); return authResp(users.get(id)!); },
      async login(i) {
        await sleep();
        const u = [...users.values()].find((x) => x.kind === 'user' && x.email?.toLowerCase() === i.email.toLowerCase());
        if (!u || u.password !== i.password) throw new ApiError(401, 'invalid_credentials', 'Incorrect email or password');
        return authResp(u);
      },
      async logout() { me = null; },
      async me() { await sleep(60); return toMe(authed()); },
      async upgrade(i) {
        await sleep(); const u = authed();
        if (u.kind !== 'guest') throw new ApiError(409, 'not_a_guest', 'Only guest accounts can be upgraded');
        dupFree(i.email);
        Object.assign(u, { kind: 'user', email: i.email, password: i.password, displayName: i.displayName });   // same id => data kept
        return { token: [...sessions].find(([, v]) => v === u.id)![0], expiresAt: iso(Date.now() + 30 * 24 * H), me: toMe(u) };
      },
    },
    invitations: {
      async preview(token) {
        await sleep(); const inv = invites.get(token);
        if (!inv) throw new ApiError(404, 'not_found', 'This invitation link is not valid');
        const g = groups.get(inv.groupId)!;
        return { groupName: g.name, groupImageUrl: g.imageUrl, invitedBy: users.get(inv.by)!.displayName, email: inv.email.replace(/^(.).*(@.*)$/, '$1***$2'), loginRequired: token === 'login-demo', expired: false };
      },
      async accept(token, displayName) {
        await sleep(); const inv = invites.get(token);
        if (!inv) throw new ApiError(404, 'not_found', 'This invitation link is not valid');
        if (token === 'login-demo' && !me) throw new ApiError(409, 'login_required', 'Log in to your account to accept this invitation');
        if (!me && !displayName) throw new ApiError(400, 'display_name_required', 'Tell us your name to join as a guest');
        let auth: AuthResponse | undefined;
        if (!me) { const id = mkUser({ kind: 'guest', email: inv.email, displayName: displayName! }); auth = authResp(users.get(id)!); }
        const g = groups.get(inv.groupId)!;
        if (!g.members.has(me!)) {
          g.members.set(me!, { role: 'member', lastRead: 0, joinedAt: iso(Date.now()) });
          const m = postMsg(g.id, null, 'system', `${users.get(me!)!.displayName} joined the group.`); g.members.get(me!)!.lastRead = m.id;
        }
        return { group: groupDto(g, me!), ...(auth ? { auth } : {}) };
      },
    },
    groups: {
      async list() { await sleep(); const u = authed(); return [...groups.values()].filter((g) => g.members.has(u.id)).map((g) => groupDto(g, u.id)).sort((a, b) => (b.lastMessage?.createdAt ?? '').localeCompare(a.lastMessage?.createdAt ?? '')); },
      async get(id) { await sleep(60); return groupDto(needMember(id), authed().id); },
      async create(i) {
        await sleep(300); const u = authed();
        if (u.kind !== 'user') throw new ApiError(403, 'forbidden', 'A registered account is required for this action');
        const id = `g-${uid()}`; const g = mkGroup(id, i.name, u.id, [], i.location, 0);
        g.imageUrl = i.image ? URL.createObjectURL(i.image) : null;
        for (const email of i.emails) invites.set(`tok-${uid()}`, { groupId: id, email, by: u.id });
        return groupDto(g, u.id);
      },
      async members(id) {
        await sleep(); const g = needMember(id); const mine = g.members.get(authed().id)!;
        return [...g.members].map(([uidv, m]): GroupMember => ({ ...profile(uidv)!, role: m.role, joinedAt: m.joinedAt, ...(mine.role !== 'member' ? { email: users.get(uidv)!.email } : {}) }));
      },
      async locations() { await sleep(); const u = authed(); return [...groups.values()].filter((g) => g.members.has(u.id) && g.location).map((g) => ({ groupId: g.id, name: g.name, imageUrl: g.imageUrl, location: g.location! })); },
      async invite(id, emails) {
        await sleep(); const g = needMember(id); const mine = g.members.get(authed().id)!;
        if (mine.role === 'member') throw new ApiError(403, 'forbidden', 'Group admin rights required');
        for (const e of emails) invites.set(`tok-${uid()}`, { groupId: id, email: e, by: me! });
        return emails.map((email) => ({ email, result: 'sent' }));
      },
      async leave(groupId, myId) {
        await sleep(); const g = needMember(groupId);
        if (g.members.get(myId)?.role === 'owner') throw new ApiError(409, 'owner_cannot_leave', 'Transfer ownership or delete the group first');
        g.members.delete(myId);
        for (const e of events.values()) if (!sees(e, myId)) { e.going.delete(myId); e.tasks.forEach((tk) => { if (tk.assignee === myId && !tk.completedAt) { tk.assignee = null; tk.claimedAt = null; } }); }
        push({ type: 'group.removed', groupId });
      },
      async messages(id, before) {
        await sleep(); const u = authed(); needMember(id);
        let list = msgs.filter((m) => m.groupId === id && !(m.type === 'event' && m.eventId && !events.get(m.eventId)));
        if (before) list = list.filter((m) => m.id < before);
        const page = list.slice(-100);
        return { messages: page.map((m) => msgDto(m, u.id)), hasMore: list.length > 100 };
      },
      async send(id, body) {
        await sleep(80); const u = authed(); const g = needMember(id);
        const m: MMsg = { id: ++msgSeq, groupId: id, sender: u.id, type: 'text', body, eventId: null, createdAt: iso(Date.now()) };
        msgs.push(m);
        g.members.get(u.id)!.lastRead = m.id; friendReply(id, u.id);
        return msgDto(m, u.id);
      },
      async markRead(id) { const g = needMember(id); g.members.get(authed().id)!.lastRead = msgs.filter((m) => m.groupId === id).at(-1)?.id ?? 0; },
      async pinned(id) {
        await sleep(60); const u = authed(); needMember(id);
        return live().filter((e) => e.groupIds.includes(id) && e.status === 'active' && endOf(e) > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((e) => summary(e, u.id));
      },
    },
    events: {
      async list() { await sleep(); const u = authed(); return live().filter((e) => sees(e, u.id) && endOf(e) > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((e) => summary(e, u.id)); },
      async get(id) { await sleep(80); const u = authed(); return detail(needEvent(id), u.id); },
      async create(i: CreateEventInput) {
        await sleep(300); const u = authed();
        if (u.kind !== 'user') throw new ApiError(403, 'forbidden', 'A registered account is required for this action');
        if (Date.parse(i.startsAt) <= Date.now()) throw new ApiError(400, 'invalid_times', 'Events must start in the future');
        for (const g of i.groupIds) needMember(g);
        const e = mkEv({ creator: u.id, name: i.name, description: i.description, location: i.location, startsAt: i.startsAt, endsAt: i.endsAt ?? null, min: i.minParticipants, max: i.maxParticipants, groupIds: i.groupIds, going: [u.id], tasks: i.tasks.map((x) => t(x.title)) });
        for (const g of i.groupIds) postMsg(g, null, 'event', e.name, e.id);
        return detail(e, u.id);
      },
      async cancel(id) {
        await sleep(); const u = authed(); const e = needEvent(id);
        if (e.creator !== u.id) throw new ApiError(403, 'forbidden', 'Only the event creator can cancel this event');
        e.status = 'cancelled'; for (const g of e.groupIds) postMsg(g, null, 'system', `"${e.name}" has been cancelled.`);
        broadcastEvent(e); return detail(e, u.id);
      },
      async rsvp(id) {
        await sleep(100); const u = authed(); const e = needEvent(id);
        if (e.status === 'cancelled') throw new ApiError(409, 'event_cancelled', 'This event has been cancelled');
        if (!e.going.has(u.id)) {
          if (e.max != null && e.going.size >= e.max) throw new ApiError(409, 'event_full', 'This event is full');
          e.going.set(u.id, iso(Date.now()));
        }
        broadcastEvent(e); return detail(e, u.id);
      },
      async withdraw(id) {
        await sleep(100); const u = authed(); const e = needEvent(id);
        e.going.delete(u.id); e.tasks.forEach((tk) => { if (tk.assignee === u.id && !tk.completedAt) { tk.assignee = null; tk.claimedAt = null; } });
        broadcastEvent(e); return detail(e, u.id);
      },
      async addTask(eventId, title) {
        await sleep(80); const u = authed(); const e = needEvent(eventId);
        if (e.creator !== u.id) throw new ApiError(403, 'forbidden', 'Only the event creator can manage tasks');
        const tk = t(title); e.tasks.push(tk); broadcastEvent(e); return taskDto(e, tk);
      },
    },
    tasks: {
      async mine() {
        await sleep(); const u = authed();
        return live().filter((e) => e.status === 'active' && endOf(e) > Date.now()).flatMap((e) => e.tasks.filter((tk) => tk.assignee === u.id && !tk.completedAt).map((tk) => ({ ...taskDto(e, tk), event: { id: e.id, name: e.name, startsAt: e.startsAt, status: e.status } })))
          .sort((a, b) => a.event.startsAt.localeCompare(b.event.startsAt));
      },
      async claim(id) { return mutate(id, (e, tk, u) => { if (!e.going.has(u)) throw new ApiError(409, 'rsvp_required', 'RSVP to the event before claiming tasks'); if (tk.assignee) throw new ApiError(409, 'task_already_claimed', 'Someone else already claimed this task'); tk.assignee = u; tk.claimedAt = iso(Date.now()); }); },
      async unclaim(id) { return mutate(id, (_e, tk, u) => { if (tk.assignee !== u) throw new ApiError(403, 'forbidden', 'Only the assignee can change this task'); if (tk.completedAt) throw new ApiError(409, 'task_completed', 'Mark the task as not completed first'); tk.assignee = null; tk.claimedAt = null; }); },
      async complete(id) { return mutate(id, (_e, tk, u) => { if (tk.assignee !== u) throw new ApiError(403, 'forbidden', 'Only the assignee can change this task'); tk.completedAt ??= iso(Date.now()); }); },
      async uncomplete(id) { return mutate(id, (_e, tk, u) => { if (tk.assignee !== u) throw new ApiError(403, 'forbidden', 'Only the assignee can change this task'); tk.completedAt = null; }); },
    },
    notifications: {
      async list() { await sleep(); const l = notifs.get(authed().id) ?? []; return { notifications: l, unreadCount: l.filter((n) => !n.readAt).length }; },
      async markRead(id) { const n = (notifs.get(authed().id) ?? []).find((x) => x.id === id); if (n) n.readAt ??= iso(Date.now()); },
      async markAllRead() { for (const n of notifs.get(authed().id) ?? []) n.readAt ??= iso(Date.now()); },
      async getPrefs() { await sleep(60); const u = authed(); if (!prefs.has(u.id)) prefs.set(u.id, defaultPrefs()); return prefs.get(u.id)!; },
      async setPrefs(p) { const u = authed(); const cur = prefs.get(u.id) ?? defaultPrefs(); const next = { ...cur, ...p }; prefs.set(u.id, next); return next; },
    },
    maps: { async search(q) { await sleep(180); const s = q.toLowerCase(); return MOCK_PLACES.filter((p) => `${p.name} ${p.address}`.toLowerCase().includes(s)); } },
    realtime: { connect(_tok, h) { handlers.add(h); return () => { handlers.delete(h); }; } },
    setToken(t) { me = t ? sessions.get(t) ?? null : null; },
  };
  for (const ns of ['auth', 'invitations', 'groups', 'events', 'tasks', 'notifications'] as const) {
    const group = api[ns] as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const k of Object.keys(group)) { const f = group[k]!; group[k] = async (...a) => { try { return await f(...a); } finally { save(); } }; }
  }
  if (!restored) save();

  async function mutate(taskId: string, fn: (e: MEvent, t: MTask, user: string) => void): Promise<Task> {
    await sleep(100); const u = authed();
    for (const e of events.values()) {
      const tk = e.tasks.find((x) => x.id === taskId);
      if (tk) { needEvent(e.id); if (e.status === 'cancelled') throw new ApiError(409, 'event_cancelled', 'This event has been cancelled'); fn(e, tk, u.id); broadcastEvent(e); return taskDto(e, tk); }
    }
    throw new ApiError(404, 'not_found', 'Task not found');
  }
  return api;
}
