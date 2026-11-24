/**
 * UI view-model types. The screens only ever see these; `http.ts` translates the backend's
 * snake_case API (backend/docs/API.md) into them, and `mock.ts` produces them directly.
 * Timestamps are ISO-8601 strings. `Message.id` is an increasing integer (ordering / unread).
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
  | 'event_updated' | 'event_cancelled' | 'event_min_met' | 'smart_reminder';

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
  pushEnabled: boolean;
  emailEnabled: boolean;
  /** hours before an event that the "coming up" reminder is sent (1–168) */
  reminderLeadHours: number;
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
