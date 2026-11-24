/**
 * Shared API data types (the JSON the backend sends/accepts). The frontend can copy or import
 * this file. All timestamps are ISO-8601 UTC strings. All ids are opaque strings, except
 * `Message.id` which is a monotonically increasing integer per server (use for ordering/unread).
 */

export type IdentityKind = 'user' | 'guest';
export type GroupRole = 'owner' | 'admin' | 'member';

export interface Location {
  name: string | null;
  address: string | null;
  placeId: string | null;
  lat: number;
  lng: number;
}

export interface PublicProfile {
  id: string;
  displayName: string;
  kind: IdentityKind;
}

export interface Me extends PublicProfile {
  email: string | null;
}

export interface AuthResponse {
  token: string;            // send as `Authorization: Bearer <token>`
  expiresAt: string;
  me: Me;
}

export interface Group {
  id: string;
  name: string;
  imageUrl: string | null;
  location: Location | null;
  myRole: GroupRole;
  memberCount: number;
  unreadCount: number;
  lastMessage: Message | null;
  createdAt: string;
}

export interface GroupMember extends PublicProfile {
  role: GroupRole;
  joinedAt: string;
  /** Only present for owners/admins viewing the list. */
  email?: string | null;
}

export interface GroupLocation {
  groupId: string;
  name: string;
  imageUrl: string | null;
  location: Location;
}

export interface Invitation {
  id: string;
  groupId: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked';
  expiresAt: string;
  createdAt: string;
}

export interface InvitationPreview {
  groupName: string;
  groupImageUrl: string | null;
  invitedBy: string;
  email: string;
  /** true if the email belongs to a registered account: client must log in then accept. */
  loginRequired: boolean;
  expired: boolean;
}

export interface EventParticipant extends PublicProfile {
  rsvpAt: string;
}

export interface EventSummary {
  id: string;
  name: string;
  description: string;
  location: Location | null;
  startsAt: string;
  endsAt: string | null;
  status: 'active' | 'cancelled';
  minParticipants: number;
  maxParticipants: number | null;
  goingCount: number;
  minimumMet: boolean;
  full: boolean;
  creator: PublicProfile;
  groupIds: string[];            // only groups the requester can see
  taskCounts: { total: number; unassigned: number; assigned: number; completed: number };
  /** Personal fields (omitted in realtime broadcasts) */
  myRsvp?: 'going' | 'not_going';
}

export interface Task {
  id: string;
  eventId: string;
  title: string;
  description: string;
  status: 'unassigned' | 'assigned' | 'completed';
  assignee: PublicProfile | null;
  claimedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface EventDetail extends EventSummary {
  participants: EventParticipant[];
  tasks: Task[];
  isCreator: boolean;
}

export interface OutstandingTask extends Task {
  event: { id: string; name: string; startsAt: string; status: 'active' | 'cancelled' };
}

export type MessageType = 'text' | 'event' | 'system';
export interface Message {
  id: number;
  groupId: string;
  sender: PublicProfile | null;   // null for system / event messages
  type: MessageType;
  body: string;
  createdAt: string;
  /** Present for type === 'event'. Live state (counts update; `myRsvp` included). */
  event?: EventSummary;
}

export type NotificationType =
  | 'group_invite' | 'new_event' | 'event_reminder' | 'task_reminder'
  | 'event_updated' | 'event_cancelled' | 'event_min_met' | 'smart_reminder' | 'new_message';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  eventId: string | null;
  groupId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPreferences {
  groupInvites: boolean;
  newEvents: boolean;
  eventReminders: boolean;
  taskReminders: boolean;
  eventChanges: boolean;
  smartReminders: boolean;
  messages: boolean;
  pushEnabled: boolean;
  emailEnabled: boolean;
}

export interface PlaceResult {
  placeId: string | null;
  name: string | null;
  address: string | null;
  lat: number;
  lng: number;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

/** Realtime (WebSocket) – server → client */
export type ServerWsMessage =
  | { type: 'ready'; me: Me }
  | { type: 'message.new'; message: Message }
  | { type: 'message.ack'; clientId?: string; message: Message }
  | { type: 'event.updated'; event: EventSummary; groupIds: string[] }
  | { type: 'event.deleted'; eventId: string; groupIds: string[] }
  | { type: 'rsvp.changed'; eventId: string; goingCount: number; minimumMet: boolean; full: boolean; participants: EventParticipant[] }
  | { type: 'task.changed'; eventId: string; task: Task }
  | { type: 'task.deleted'; eventId: string; taskId: string }
  | { type: 'group.updated'; groupId: string }
  | { type: 'group.removed'; groupId: string }
  | { type: 'notification.new'; notification: Notification }
  | { type: 'error'; code: string; message: string; clientId?: string }
  | { type: 'pong' };

/** Realtime (WebSocket) – client → server */
export type ClientWsMessage =
  | { type: 'auth'; token: string }
  | { type: 'message.send'; groupId: string; body: string; clientId?: string }
  | { type: 'read'; groupId: string; upToMessageId?: number }
  | { type: 'ping' };
