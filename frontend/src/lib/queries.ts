import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type EventDetail, type EventSummary } from '../api';
import { useAuth } from './auth';
import { useToast, errorText } from './toast';

const enabled = () => !!useAuth().me;
export const useGroups = () => useQuery({ queryKey: ['groups'], queryFn: api.groups.list, enabled: enabled() });
export const useGroup = (id: string) => useQuery({ queryKey: ['group', id], queryFn: () => api.groups.get(id), enabled: enabled() });
export const useMembers = (id: string) => useQuery({ queryKey: ['members', id], queryFn: () => api.groups.members(id), enabled: enabled() });
export const useLocations = () => useQuery({ queryKey: ['locations'], queryFn: api.groups.locations, enabled: enabled() });
export const usePinned = (id: string) => useQuery({ queryKey: ['pinned', id], queryFn: () => api.groups.pinned(id), enabled: enabled() });
export const useEvents = () => useQuery({ queryKey: ['events'], queryFn: api.events.list, enabled: enabled() });
export const useEvent = (id: string) => useQuery({ queryKey: ['event', id], queryFn: () => api.events.get(id), enabled: enabled(), retry: (n, e: any) => e?.status !== 404 && n < 2 });
export const useMyTasks = () => useQuery({ queryKey: ['tasks', 'mine'], queryFn: api.tasks.mine, enabled: enabled() });
export const useNotifications = () => useQuery({ queryKey: ['notifications'], queryFn: api.notifications.list, enabled: enabled() });
export const usePrefs = () => useQuery({ queryKey: ['prefs'], queryFn: api.notifications.getPrefs, enabled: enabled() });

/** Join / leave an event from anywhere (chat message, pinned card, event page) with consistent cache updates. */
export function useRsvp() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, join }: { id: string; join: boolean }) => (join ? api.events.rsvp(id) : api.events.withdraw(id)),
    onSuccess: (d: EventDetail, { join }) => {
      qc.setQueryData(['event', d.id], d);
      const patch = (e: EventSummary) => (e.id === d.id ? { ...e, goingCount: d.goingCount, minimumMet: d.minimumMet, full: d.full, myRsvp: d.myRsvp } : e);
      qc.setQueryData<EventSummary[]>(['events'], (l) => l?.map(patch));
      qc.setQueriesData<EventSummary[]>({ queryKey: ['pinned'] }, (l) => l?.map(patch));
      qc.setQueriesData<{ messages: any[]; hasMore: boolean }>({ queryKey: ['messages'] }, (m) => m && { ...m, messages: m.messages.map((x) => (x.event?.id === d.id ? { ...x, event: patch(x.event) } : x)) });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      toast(join ? "You're going 🎉" : 'You left the event');
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
}
