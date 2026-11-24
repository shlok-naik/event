import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type EventSummary, type Message, type ServerWsMessage } from '../api';
import { useAuth } from './auth';
import { useToast } from './toast';

const merge = (old: EventSummary, next: EventSummary): EventSummary => ({ ...next, myRsvp: old.myRsvp, groupIds: old.groupIds });

function patchEvent(qc: QueryClient, ev: EventSummary) {
  qc.setQueriesData<{ messages: Message[]; hasMore: boolean }>({ queryKey: ['messages'] }, (d) =>
    d && { ...d, messages: d.messages.map((m) => (m.event?.id === ev.id ? { ...m, event: merge(m.event, ev) } : m)) });
  qc.setQueriesData<EventSummary[]>({ queryKey: ['pinned'] }, (d) => d?.map((e) => (e.id === ev.id ? merge(e, ev) : e)));
  qc.setQueryData<EventSummary[]>(['events'], (d) => d?.map((e) => (e.id === ev.id ? merge(e, ev) : e)));
}

/** Applies server pushes to the query cache so every screen updates live. */
export function RealtimeBridge() {
  const qc = useQueryClient();
  const { token } = useAuth();
  const toast = useToast();

  useEffect(() => {
    if (!token) return;
    const onMsg = (m: ServerWsMessage) => {
      switch (m.type) {
        case 'message.new':
          qc.setQueryData<{ messages: Message[]; hasMore: boolean }>(['messages', m.message.groupId], (d) =>
            d && (d.messages.some((x) => x.id === m.message.id) ? d : { ...d, messages: [...d.messages, m.message] }));
          qc.invalidateQueries({ queryKey: ['groups'] });
          break;
        case 'event.updated':
          patchEvent(qc, m.event);
          qc.invalidateQueries({ queryKey: ['event', m.event.id] });
          qc.invalidateQueries({ queryKey: ['events'] });
          for (const g of m.groupIds) qc.invalidateQueries({ queryKey: ['pinned', g] });
          qc.invalidateQueries({ queryKey: ['groups'] });
          break;
        case 'rsvp.changed':
        case 'task.changed':
        case 'task.deleted':
          qc.invalidateQueries({ queryKey: ['event', m.eventId] });
          qc.invalidateQueries({ queryKey: ['tasks'] });
          break;
        case 'event.deleted':
          qc.removeQueries({ queryKey: ['event', m.eventId] });
          for (const k of ['events', 'pinned', 'tasks', 'messages', 'groups']) qc.invalidateQueries({ queryKey: [k] });
          break;
        case 'notification.new':
          qc.invalidateQueries({ queryKey: ['notifications'] });
          toast(m.notification.title);
          break;
        case 'group.updated':
        case 'group.removed':
          for (const k of ['groups', 'locations', 'members']) qc.invalidateQueries({ queryKey: [k] });
          break;
      }
    };
    return api.realtime.connect(token, onMsg);
  }, [token, qc, toast]);
  return null;
}
