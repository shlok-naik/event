import type { EventSummary } from '../api/types';

/** Mirrors the backend rule: an event ends at endsAt, or 3 hours after it starts. */
const DEFAULT_LENGTH_MS = 3 * 3_600_000;
export const endMs = (e: Pick<EventSummary, 'startsAt' | 'endsAt'>) => (e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + DEFAULT_LENGTH_MS);

/** Has taken place -> disappears from upcoming lists, pinned strips and task lists. */
export const hasEnded = (e: Pick<EventSummary, 'startsAt' | 'endsAt'>, now = Date.now()) => endMs(e) <= now;

/** Backend deletes events a short while after they end; after this we treat the event as gone. */
export const RETENTION_MS = 30 * 60_000;
export const isGone = (e: Pick<EventSummary, 'startsAt' | 'endsAt'>, now = Date.now()) => endMs(e) + RETENTION_MS <= now;

export const isUpcoming = (e: EventSummary, now = Date.now()) => !hasEnded(e, now);
export const isLive = (e: Pick<EventSummary, 'startsAt' | 'endsAt'>, now = Date.now()) => Date.parse(e.startsAt) <= now && !hasEnded(e, now);
