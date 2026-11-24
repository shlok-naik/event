import type {
  AuthResponse, EventDetail, EventSummary, Group, GroupLocation, GroupMember, InvitationPreview, Location, Me,
  Message, Notification, NotificationPreferences, OutstandingTask, PlaceResult, Task,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

/** What the realtime layer tells the UI. Payloads are deliberately small: the UI patches or refetches. */
export type RealtimeEvent =
  | { type: 'message.new'; message: Message }
  | { type: 'event.changed'; eventId: string }
  | { type: 'event.deleted'; eventIds: string[] }
  | { type: 'rsvp.changed'; eventId: string; goingCount: number; minimumMet: boolean; full: boolean }
  | { type: 'task.changed'; eventId: string }
  | { type: 'notification.new'; notification: Notification }
  | { type: 'group.changed'; groupId: string }
  | { type: 'group.removed'; groupId: string };

export interface CreateGroupInput { name: string; location: Location | null; image: File | null; emails: string[] }
export interface CreateEventInput {
  name: string; description: string; location: Location | null; startsAt: string; endsAt?: string | null;
  minParticipants: number; maxParticipants: number | null; groupIds: string[]; tasks: { title: string }[];
}

/** Everything the UI needs from a backend. Implemented by http.ts (real) and mock.ts (demo data). */
export interface Api {
  auth: {
    register(i: { email: string; password: string; displayName: string }): Promise<AuthResponse>;
    login(i: { email: string; password: string }): Promise<AuthResponse>;
    logout(): Promise<void>;
    me(): Promise<Me>;
    /** Guests keep their invited email; only password + name are sent. */
    upgrade(i: { password: string; displayName: string }): Promise<AuthResponse>;
    /** Exchange the one-time token from a guest sign-in email. */
    guestSession(token: string): Promise<AuthResponse>;
    /** Email a returning guest a one-time sign-in link (always succeeds, to avoid revealing who is a guest). */
    requestGuestLink(email: string): Promise<void>;
  };
  invitations: {
    preview(token: string): Promise<InvitationPreview>;
    accept(token: string, displayName?: string): Promise<{ group: Group; auth?: AuthResponse }>;
  };
  groups: {
    list(): Promise<Group[]>;
    get(id: string): Promise<Group>;
    create(i: CreateGroupInput): Promise<Group>;
    members(id: string): Promise<GroupMember[]>;
    locations(): Promise<GroupLocation[]>;
    invite(id: string, emails: string[]): Promise<{ email: string; result: string }[]>;
    leave(groupId: string, myId: string): Promise<void>;
    messages(id: string, before?: number): Promise<{ messages: Message[]; hasMore: boolean }>;
    send(id: string, body: string): Promise<Message>;
    markRead(id: string, upToMessageId: number): Promise<void>;
    pinned(id: string): Promise<EventSummary[]>;
  };
  events: {
    list(): Promise<EventSummary[]>;
    get(id: string): Promise<EventDetail>;
    create(i: CreateEventInput): Promise<EventDetail>;
    cancel(id: string): Promise<EventDetail>;
    rsvp(id: string): Promise<EventDetail>;
    withdraw(id: string): Promise<EventDetail>;
    addTask(eventId: string, title: string): Promise<Task>;
  };
  tasks: {
    mine(): Promise<OutstandingTask[]>;
    claim(eventId: string, taskId: string): Promise<Task>;
    unclaim(eventId: string, taskId: string): Promise<Task>;
    complete(eventId: string, taskId: string): Promise<Task>;
    /** Not supported by the backend yet: completing is one-way. */
    uncomplete?(eventId: string, taskId: string): Promise<Task>;
  };
  notifications: {
    list(): Promise<{ notifications: Notification[]; unreadCount: number }>;
    markRead(id: string): Promise<void>;
    markAllRead(): Promise<void>;
    getPrefs(): Promise<NotificationPreferences>;
    setPrefs(p: Partial<NotificationPreferences>): Promise<NotificationPreferences>;
  };
  maps: { search(q: string): Promise<PlaceResult[]> };
  /** Realtime: handler receives server pushes while connected. Returns an unsubscribe fn. */
  realtime: { connect(token: string, handler: (m: RealtimeEvent) => void): () => void };
  /** Mock only: re-associates the current user with a stored token after a reload. */
  setToken?(t: string | null): void;
}
