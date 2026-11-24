import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type OutstandingTask, type Task } from '../api';
import { errorText, useToast } from '../lib/toast';
import { relative, when } from '../lib/format';
import { useNow } from '../lib/hooks';
import { Avatar, Button, Tag } from './ui';
import { useAuth } from '../lib/auth';

/** Tick off a task you own. Used on Home, the Tasks page and (via TaskItem) the event page. */
export function TaskRow({ task, showEvent }: { task: OutstandingTask; showEvent?: boolean }) {
  const qc = useQueryClient(); const toast = useToast(); const now = useNow();
  const m = useMutation({
    mutationFn: (done: boolean) => (done ? api.tasks.complete(task.id) : api.tasks.uncomplete(task.id)),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ['event', t.eventId] }); qc.invalidateQueries({ queryKey: ['events'] }); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const [done, setDone] = useState(false);   // optimistic tick; rolled back if the request fails
  const left = Date.parse(task.event.startsAt) - now; const soon = left < 24 * 3_600_000;
  return (
    <div className={`task ${done ? 'done' : ''}`}>
      <input type="checkbox" className="check" checked={done} disabled={m.isPending} aria-label={`Mark "${task.title}" as done`} onChange={(e) => { setDone(e.target.checked); m.mutate(e.target.checked, { onError: () => setDone(!e.target.checked) }); }} />
      <div className="grow">
        <div className="ttl">{task.title}</div>
        {showEvent && <Link className="small muted" to={`/events/${task.event.id}`}>{task.event.name} · {when(task.event.startsAt)}</Link>}
      </div>
      {soon && !done && <Tag tone="warn">{left > 0 ? relative(task.event.startsAt, now) : 'now'}</Tag>}
    </div>
  );
}

/** Row on the event page: claim / unclaim / tick. */
export function TaskItem({ task, isParticipant, locked }: { task: Task; isParticipant: boolean; locked: boolean }) {
  const { me } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const m = useMutation({
    mutationFn: (a: 'claim' | 'unclaim' | 'complete' | 'uncomplete') => api.tasks[a](task.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['event', task.eventId] }); qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['events'] }); },
    onError: (e) => { toast(errorText(e), 'error'); qc.invalidateQueries({ queryKey: ['event', task.eventId] }); },
  });
  const mine = task.assignee?.id === me?.id;
  const [override, setOverride] = useState<boolean | null>(null);   // optimistic tick until the server state arrives
  useEffect(() => setOverride(null), [task.status]);
  const done = override ?? task.status === 'completed';
  return (
    <div className={`task ${done ? 'done' : ''}`} data-testid="task">
      {mine ? <input type="checkbox" className="check" checked={done} disabled={m.isPending || locked} aria-label={`Mark "${task.title}" as done`} onChange={(e) => { setOverride(e.target.checked); m.mutate(e.target.checked ? 'complete' : 'uncomplete', { onError: () => setOverride(null) }); }} />
        : done ? <input type="checkbox" className="check" checked disabled aria-label="Completed" /> : <span style={{ width: 26 }} />}
      <div className="grow"><div className="ttl">{task.title}</div>
        {task.assignee ? <div className="row small muted" style={{ gap: 6 }}><Avatar name={task.assignee.displayName} size={18} />{mine ? 'You' : task.assignee.displayName}{done && ' · done'}</div> : <div className="small muted">Unassigned</div>}
      </div>
      {!locked && task.status === 'unassigned' && <Button small variant="secondary" disabled={m.isPending || !isParticipant} title={isParticipant ? undefined : 'Join the event to claim tasks'} onClick={() => m.mutate('claim')}>Claim</Button>}
      {!locked && mine && !done && <Button small variant="ghost" disabled={m.isPending} onClick={() => m.mutate('unclaim')}>Release</Button>}
    </div>
  );
}
