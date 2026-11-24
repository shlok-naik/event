import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type EventSummary, type Message, type RealtimeEvent } from '../api';
import { useAuth } from './auth';
import { useToast } from './toast';

type Counts = Pick<EventSummary, 'goingCount' | 'minimumMet' | 'full'>;

/** Patch headcounts everywhere an event summary is cached, so chat cards / pins / lists update instantly. */
function patchCounts(qc: QueryClient, id: string, c: Counts) {
  const patch = (e: EventSummary) => (e.id === id ? { ...e, ...c } : e);
  qc.setQueriesData<{ messages: Message[]; hasMore: boolean }>({ queryKey: ['messages'] }, (d) => d && { ...d, messages: d.messages.map((m) => (m.event?.id === id ? { ...m, event: patch(m.event) } : m)) });
  qc.setQueriesData<EventSummary[]>({ queryKey: ['pinned'] }, (d) => d?.map(patch));
  qc.setQueryData<EventSummary[]>(['events'], (d) => d?.map(patch));
}

/** Applies server pushes to the query cache so every screen updates live. */
export function RealtimeBridge() {
  const qc = useQueryClient();
  const { token } = useAuth();
  const toast = useToast();

  useEffect(() => {
    if (!token) return;
    const refresh = (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    const onMsg = (m: RealtimeEvent) => {
      switch (m.type) {
        case 'message.new':
          if (m.message.type === 'event') refresh('messages', 'pinned', 'events');     // event cards carry per-user RSVP state: refetch
          else qc.setQueryData<{ messages: Message[]; hasMore: boolean }>(['messages', m.message.groupId], (d) => d && (d.messages.some((x) => x.id === m.message.id) ? d : { ...d, messages: [...d.messages, m.message] }));
          refresh('groups');
          break;
        case 'event.changed':
          refresh('events', 'pinned', 'messages', 'groups', 'tasks'); qc.invalidateQueries({ queryKey: ['event', m.eventId] });
          break;
        case 'rsvp.changed':
          patchCounts(qc, m.eventId, { goingCount: m.goingCount, minimumMet: m.minimumMet, full: m.full }); qc.invalidateQueries({ queryKey: ['event', m.eventId] });
          break;
        case 'task.changed':
          qc.invalidateQueries({ queryKey: ['event', m.eventId] }); refresh('tasks', 'events');
          break;
        case 'event.deleted':
          for (const id of m.eventIds) qc.removeQueries({ queryKey: ['event', id] });
          refresh('events', 'pinned', 'tasks', 'messages', 'groups');
          break;
        case 'notification.new':
          refresh('notifications'); toast(m.notification.title);
          break;
        case 'group.changed':
        case 'group.removed':
          refresh('groups', 'locations', 'members', 'group');
          break;
      }
    };
    return api.realtime.connect(token, onMsg);
  }, [token, qc, toast]);
  return null;
}
