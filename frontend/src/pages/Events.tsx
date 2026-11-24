import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Location } from '../api';
import { useAuth } from '../lib/auth';
import { useEvent, useGroups } from '../lib/queries';
import { useNow } from '../lib/hooks';
import { hasEnded, isGone } from '../lib/lifecycle';
import { plural, relative, toLocalInput, when } from '../lib/format';
import { errorText, useToast } from '../lib/toast';
import { ApiError } from '../api';
import { Icon } from '../components/Icon';
import { Avatar, Button, Empty, ErrorState, Field, Loading, Progress, Sheet, Stepper, Tag, TextArea, TextInput, TopBar, Toggle } from '../components/ui';
import { LocationPicker } from '../components/LocationPicker';
import { MapView, mapsLink } from '../components/MapView';
import { JoinButton } from '../components/EventBits';
import { TaskItem } from '../components/TaskRow';
import { RegisteredOnly } from './Groups';

const SUGGESTIONS = ['Snacks', 'Drinks', 'Speaker', 'Chairs', 'Games', 'Cash for tickets'];

export function EventNew() {
  const { isUser } = useAuth(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast();
  const [sp] = useSearchParams(); const groups = useGroups();
  const [f, setF] = useState(() => { const d = new Date(Date.now() + 86_400_000); d.setHours(18, 0, 0, 0); return { name: '', description: '', start: toLocalInput(d) }; });
  const [loc, setLoc] = useState<Location | null>(null);
  const [min, setMin] = useState(2); const [hasMax, setHasMax] = useState(false); const [max, setMax] = useState(8);
  const [tasks, setTasks] = useState<string[]>([]); const [taskText, setTaskText] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const gid = sp.get('groupId');
  const selected = picked ?? (gid ? [gid] : groups.data?.length === 1 ? [groups.data[0]!.id] : []);

  const m = useMutation({
    mutationFn: () => api.events.create({
      name: f.name.trim(), description: f.description.trim(), location: loc, startsAt: new Date(f.start).toISOString(),
      minParticipants: min, maxParticipants: hasMax ? Math.max(max, min) : null, groupIds: selected, tasks: tasks.map((title) => ({ title })),
    }),
    onSuccess: (e) => { for (const k of ['events', 'groups', 'pinned', 'messages']) qc.invalidateQueries({ queryKey: [k] }); toast(`Event sent to ${plural(selected.length, 'group')} 🎉`, 'success'); nav(`/events/${e.id}`, { replace: true }); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  if (!isUser) return <RegisteredOnly what="Create an event" />;
  const addTask = (t: string) => { const v = t.trim(); if (v && !tasks.includes(v) && tasks.length < 50) setTasks([...tasks, v]); setTaskText(''); };
  const toggleGroup = (id: string) => setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!f.name.trim()) er.name = 'Give your event a name';
    if (!f.start || Number.isNaN(Date.parse(f.start))) er.start = 'Pick a date and time'; else if (Date.parse(f.start) <= Date.now()) er.start = 'Choose a time in the future';
    if (!selected.length) er.groups = 'Choose at least one group to send it to';
    setErrs(er); if (!Object.keys(er).length) m.mutate();
  };
  const set = (k: 'name' | 'description' | 'start') => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <>
      <TopBar title="New event" />
      <div className="page"><form className="container formpage" onSubmit={submit} noValidate><div className="stack">
        <Field label="Event name" error={f.name.trim() ? null : errs.name}>{(id, bad) => <TextInput id={id} value={f.name} onChange={set('name')} invalid={bad} maxLength={120} placeholder="e.g. Friday bouldering" autoFocus />}</Field>
        <Field label="Description (optional)">{(id) => <TextArea id={id} value={f.description} onChange={set('description')} maxLength={5000} placeholder="What should people know?" />}</Field>
        <Field label="Where?">{(id) => <LocationPicker id={id} value={loc} onChange={setLoc} />}</Field>
        <Field label="When?" error={f.start && Date.parse(f.start) > Date.now() ? null : errs.start}>{(id, bad) => <TextInput id={id} type="datetime-local" value={f.start} onChange={set('start')} invalid={bad} />}</Field>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row"><div className="grow"><div className="label">Minimum people needed</div><div className="hint">The event is "on" once this many join</div></div><Stepper label="minimum" value={min} onChange={(n) => { setMin(n); if (max < n) setMax(n); }} /></div>
          <div className="row"><div className="grow"><div className="label">Limit the number of people</div><div className="hint">Optional maximum</div></div><Toggle label="Set a maximum" checked={hasMax} onChange={setHasMax} />{hasMax && <Stepper label="maximum" value={Math.max(max, min)} min={min} onChange={setMax} />}</div>
        </div>
        <div className="field"><span className="label" id="tl">Tasks & things to bring</span>
          <div className="row"><input className="input" aria-labelledby="tl" value={taskText} onChange={(e) => setTaskText(e.target.value)} placeholder="Add a task or item" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTask(taskText); } }} /><Button type="button" variant="secondary" onClick={() => addTask(taskText)} disabled={!taskText.trim()}>Add</Button></div>
          <div className="chips">{SUGGESTIONS.filter((s) => !tasks.includes(s)).map((s) => <button type="button" key={s} className="chip" onClick={() => addTask(s)}>+ {s}</button>)}</div>
          {tasks.length > 0 && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Tasks">{tasks.map((t) => <li className="task" key={t}><span className="grow">{t}</span><button type="button" className="iconbtn" aria-label={`Remove ${t}`} onClick={() => setTasks(tasks.filter((x) => x !== t))}><Icon name="close" size={18} /></button></li>)}</ul>}
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label" style={{ marginBottom: 8 }}>Send to</legend>
          {groups.isLoading ? <Loading rows={1} /> : groups.isError ? <ErrorState error={groups.error} onRetry={() => groups.refetch()} /> : (
            <div className="chips">{groups.data!.map((g) => <button type="button" key={g.id} className={`chip ${selected.includes(g.id) ? 'sel' : ''}`} aria-pressed={selected.includes(g.id)} onClick={() => toggleGroup(g.id)}>{selected.includes(g.id) && '✓ '}{g.name}</button>)}</div>)}
          {errs.groups && !selected.length && <div className="err" role="alert" style={{ marginTop: 6 }}>{errs.groups}</div>}
          {selected.length > 1 && <p className="hint" style={{ marginTop: 6 }}>Everyone shares the same RSVPs and tasks across these groups.</p>}
        </fieldset>
        <Button type="submit" block disabled={m.isPending}>{m.isPending ? 'Creating…' : 'Create event'}</Button>
      </div></form></div>
    </>
  );
}

export function EventPage() {
  const { id = '' } = useParams(); const { me } = useAuth(); const q = useEvent(id); const groups = useGroups(); const now = useNow();
  const qc = useQueryClient(); const toast = useToast(); const nav = useNavigate();
  const [newTask, setNewTask] = useState(''); const [confirm, setConfirm] = useState(false);
  const add = useMutation({ mutationFn: (t: string) => api.events.addTask(id, t), onSuccess: () => { setNewTask(''); qc.invalidateQueries({ queryKey: ['event', id] }); }, onError: (e) => toast(errorText(e), 'error') });
  const cancel = useMutation({ mutationFn: () => api.events.cancel(id), onSuccess: (d) => { qc.setQueryData(['event', id], d); for (const k of ['events', 'pinned', 'tasks']) qc.invalidateQueries({ queryKey: [k] }); setConfirm(false); toast('Event cancelled'); }, onError: (e) => toast(errorText(e), 'error') });

  if (q.isLoading) return <><TopBar title="Event" /><Loading rows={4} /></>;
  if (q.isError && (q.error instanceof ApiError && q.error.status === 404)) return <><TopBar title="Event" /><Empty icon="calendar" title="This event is no longer available" action={<Link className="btn" to="/">Back home</Link>}>It may have already taken place or been removed.</Empty></>;
  if (q.isError) return <><TopBar title="Event" /><ErrorState error={q.error} onRetry={() => q.refetch()} /></>;
  const e = q.data!;
  if (isGone(e, now)) return <><TopBar title="Event" /><Empty icon="calendar" title="This event has taken place" action={<Link className="btn" to="/">Back home</Link>} /></>;
  const ended = hasEnded(e, now); const cancelled = e.status === 'cancelled'; const locked = ended || cancelled;
  const going = e.myRsvp === 'going';
  const groupNames = (groups.data ?? []).filter((g) => e.groupIds.includes(g.id));
  const need = e.minParticipants - e.goingCount;
  const tc = e.taskCounts;
  return (
    <>
      <TopBar title={e.name} subtitle={when(e.startsAt)} />
      <div className="page"><div className="container stack" style={{ paddingTop: 16, paddingBottom: 24, gap: 16 }}>
        {cancelled && <div className="banner" role="alert">This event has been cancelled.</div>}
        {ended && !cancelled && <div className="banner">This event has ended. It will disappear shortly.</div>}
        <div className="card stack">
          <div className="row"><Icon name="clock" /><div className="grow"><div className="strong">{when(e.startsAt)}</div><div className="small muted">{relative(e.startsAt, now)}</div></div></div>
          <div className="row"><Avatar name={e.creator.displayName} size={28} /><span className="small">Organised by <b>{e.creator.id === me?.id ? 'you' : e.creator.displayName}</b></span></div>
          {e.description && <p style={{ whiteSpace: 'pre-wrap' }}>{e.description}</p>}
          {groupNames.length > 0 && <div className="chips">{groupNames.map((g) => <Link key={g.id} to={`/groups/${g.id}`} className="chip"><Icon name="users" size={14} />{g.name}</Link>)}</div>}
        </div>

        {e.location && (
          <div className="card stack" style={{ gap: 8 }}>
            <div className="row"><Icon name="pin" /><div className="grow"><div className="strong">{e.location.name ?? 'Location'}</div>{e.location.address && <div className="small muted">{e.location.address}</div>}</div></div>
            <MapView height={170} markers={[{ id: e.id, lat: e.location.lat, lng: e.location.lng, label: e.location.name ?? e.name }]} label="Event location" />
            <a className="small" href={mapsLink(e.location.lat, e.location.lng)} target="_blank" rel="noreferrer">Open in Google Maps</a>
          </div>
        )}

        <div className="card stack" aria-label="Participation">
          <div className="row"><div className="grow"><div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{e.goingCount}<span className="muted" style={{ fontSize: '1rem', fontWeight: 500 }}> going</span></div>
            <div className="small muted">Needs {e.minParticipants}{e.maxParticipants ? ` · up to ${e.maxParticipants}` : ' · no maximum'}</div></div>
            {!locked && <JoinButton event={e} small={false} />}</div>
          <Progress value={e.goingCount} max={e.minParticipants} ok={e.minimumMet} />
          <div className={`stat ${e.minimumMet ? 'ok' : 'warn'}`} data-testid="min-status"><Icon name={e.minimumMet ? 'check' : 'users'} size={20} /><div className="small"><b>{e.minimumMet ? 'Enough people have joined' : `Needs ${plural(need, 'more person', 'more people')}`}</b><br />{e.minimumMet ? 'This event is on.' : `${e.goingCount} of ${e.minParticipants} minimum so far.`}{e.full && ' It is now full.'}</div></div>
          {tc.total > 0 && <div className={`stat ${tc.unassigned === 0 ? 'ok' : 'warn'}`} data-testid="task-status"><Icon name={tc.unassigned === 0 ? 'check' : 'tasks'} size={20} /><div className="small"><b>{tc.unassigned === 0 ? 'All tasks are assigned' : `${plural(tc.unassigned, 'task')} still ${tc.unassigned === 1 ? 'needs' : 'need'} someone`}</b><br />{tc.completed} of {tc.total} done</div></div>}
        </div>

        <section className="card" aria-labelledby="tasks">
          <div className="row" style={{ marginBottom: 4 }}><h2 id="tasks" className="grow" style={{ fontSize: '1.05rem' }}>Tasks & things to bring</h2>{tc.total > 0 && <Tag>{tc.completed}/{tc.total} done</Tag>}</div>
          {!going && !locked && tc.total > 0 && <p className="small muted">Join the event to claim a task.</p>}
          {e.tasks.length === 0 ? <p className="small muted" style={{ padding: '8px 0' }}>No tasks yet.</p> : e.tasks.map((t) => <TaskItem key={t.id} task={t} isParticipant={going} locked={locked} />)}
          {e.isCreator && !locked && (
            <form className="row" style={{ marginTop: 10 }} onSubmit={(ev) => { ev.preventDefault(); if (newTask.trim()) add.mutate(newTask.trim()); }}>
              <input className="input" placeholder="Add a task" aria-label="New task" value={newTask} onChange={(x) => setNewTask(x.target.value)} maxLength={200} /><Button small type="submit" disabled={!newTask.trim() || add.isPending}>Add</Button>
            </form>
          )}
        </section>

        <section className="card" aria-labelledby="att">
          <h2 id="att" style={{ fontSize: '1.05rem', marginBottom: 8 }}>Who's going ({e.participants.length})</h2>
          {e.participants.length === 0 ? <p className="small muted">Nobody yet – be the first!</p> : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="attendees">{e.participants.map((p) => <li key={p.id} className="row" style={{ padding: '6px 0' }}><Avatar name={p.displayName} size={36} /><span className="grow">{p.displayName}{p.id === me?.id && ' (you)'}</span>{p.kind === 'guest' && <Tag>Guest</Tag>}{p.id === e.creator.id && <Tag tone="brand">Organiser</Tag>}</li>)}</ul>
          )}
        </section>
        {e.isCreator && !locked && <Button variant="secondary" style={{ color: 'var(--danger)' }} onClick={() => setConfirm(true)}>Cancel event</Button>}
      </div></div>
      {confirm && <Sheet title="Cancel this event?" onClose={() => setConfirm(false)}><p className="muted" style={{ marginBottom: 16 }}>Everyone who joined will be notified. This can't be undone.</p><div className="row"><Button variant="secondary" className="grow" onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" className="grow" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel event</Button></div></Sheet>}
    </>
  );
}
