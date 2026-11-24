import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Notification, type NotificationPreferences } from '../api';
import { useAuth } from '../lib/auth';
import { useMyTasks, useNotifications, usePrefs } from '../lib/queries';
import { useNow } from '../lib/hooks';
import { errorText, useToast } from '../lib/toast';
import { listStamp, relative, when } from '../lib/format';
import { Icon } from '../components/Icon';
import { TaskRow } from '../components/TaskRow';
import { Avatar, Button, Empty, ErrorState, Field, Loading, Tag, TextInput, Toggle, TopBar } from '../components/ui';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api';

export function Tasks() {
  const q = useMyTasks(); const now = useNow();
  const byEvent = useMemo(() => {
    const m = new Map<string, { event: NonNullable<typeof q.data>[number]['event']; tasks: NonNullable<typeof q.data> }>();
    for (const t of q.data ?? []) { const g = m.get(t.event.id) ?? { event: t.event, tasks: [] }; g.tasks.push(t); m.set(t.event.id, g); }
    return [...m.values()].sort((a, b) => a.event.startsAt.localeCompare(b.event.startsAt));
  }, [q.data, now]);
  return (
    <>
      <TopBar back={false} title="My tasks" subtitle={q.data ? `${q.data.length} to do` : undefined} />
      <div className="page"><div className="container" style={{ paddingTop: 12 }}>
        {q.isLoading ? <Loading rows={4} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : byEvent.length === 0 ? (
          <Empty icon="tasks" title="You're all caught up 🎉">Tasks you claim for upcoming events show up here with their deadlines.</Empty>
        ) : byEvent.map(({ event, tasks }) => {
          const soon = Date.parse(event.startsAt) - now < 24 * 3_600_000;
          return (
            <section key={event.id} className="card" style={{ marginBottom: 12 }} aria-label={event.name}>
              <Link to={`/events/${event.id}`} className="row" style={{ color: 'inherit' }}>
                <div className="grow"><div className="strong">{event.name}</div><div className="small muted"><Icon name="clock" size={13} /> Due before {when(event.startsAt)}</div></div>
                <Tag tone={soon ? 'warn' : undefined}>{Date.parse(event.startsAt) > now ? relative(event.startsAt, now) : 'Happening now'}</Tag>
              </Link>
              {tasks.map((t) => <TaskRow key={t.id} task={t} />)}
            </section>
          );
        })}
      </div></div>
    </>
  );
}

const ICON: Record<Notification['type'], string> = { group_invite: 'users', new_event: 'calendar', event_reminder: 'clock', task_reminder: 'tasks', event_updated: 'sync', event_cancelled: 'close', event_min_met: 'check', smart_reminder: 'bell' };

export function Notifications() {
  const [tab, setTab] = useState<'list' | 'settings'>('list'); const nav = useNavigate(); const qc = useQueryClient();
  const q = useNotifications();
  const read = useMutation({ mutationFn: (id: string) => api.notifications.markRead(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const all = useMutation({ mutationFn: api.notifications.markAllRead, onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const open = (n: Notification) => { if (!n.readAt) read.mutate(n.id); if (n.eventId) nav(`/events/${n.eventId}`); else if (n.groupId) nav(`/groups/${n.groupId}`); };
  return (
    <>
      <TopBar back={false} title="Alerts" right={tab === 'list' && (q.data?.unreadCount ?? 0) > 0 ? <Button small variant="ghost" style={{ color: 'inherit' }} onClick={() => all.mutate()}>Mark all read</Button> : undefined} />
      <div className="page">
        <div className="container" style={{ paddingTop: 12 }}>
          <div className="chips" role="tablist" aria-label="Alerts view" style={{ marginBottom: 12 }}>
            <button role="tab" aria-selected={tab === 'list'} className={`chip ${tab === 'list' ? 'sel' : ''}`} onClick={() => setTab('list')}>Notifications{q.data?.unreadCount ? ` (${q.data.unreadCount})` : ''}</button>
            <button role="tab" aria-selected={tab === 'settings'} className={`chip ${tab === 'settings' ? 'sel' : ''}`} onClick={() => setTab('settings')}>Reminders & settings</button>
          </div>
          {tab === 'list' ? (q.isLoading ? <Loading rows={4} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data!.notifications.length === 0 ? (
            <Empty icon="bell" title="No notifications yet">Reminders, event updates and invitations will appear here.</Empty>
          ) : (
            <div className="list card" style={{ padding: 0, overflow: 'hidden' }}>
              {q.data!.notifications.map((n) => (
                <button key={n.id} className="item" onClick={() => open(n)} style={n.readAt ? undefined : { background: 'var(--brand-soft)' }}>
                  <span className="avatar" style={{ width: 40, height: 40, background: 'var(--surface-2)', color: 'var(--brand)' }}><Icon name={ICON[n.type] ?? 'bell'} size={20} /></span>
                  <div className="grow"><div className="strong ellipsis" style={{ fontWeight: n.readAt ? 500 : 700 }}>{n.title}</div><div className="small muted">{n.body}</div></div>
                  <span className="tiny muted">{listStamp(n.createdAt)}</span>
                </button>
              ))}
            </div>
          )) : <Settings />}
        </div>
      </div>
    </>
  );
}

const ROWS: { key: Exclude<keyof NotificationPreferences, 'reminderLeadHours'>; title: string; desc: string; beta?: boolean }[] = [
  { key: 'eventReminders', title: 'Event reminders', desc: 'A nudge before events you joined (choose how early below)' },
  { key: 'taskReminders', title: 'Task reminders', desc: 'Reminders for tasks you claimed but haven’t finished' },
  { key: 'smartReminders', title: 'Smart reminders', beta: true, desc: 'Reminders that adapt: more frequent as the event gets closer while you still have unfinished tasks, and a nudge when tasks still need a volunteer. Silent once you’re done.' },
  { key: 'newEvents', title: 'New events', desc: 'When someone sends an event to your group' },
  { key: 'eventChanges', title: 'Event changes', desc: 'Time or place changes, cancellations and "enough people joined"' },
  { key: 'groupInvites', title: 'Group invitations', desc: 'When you’re invited to a group' },
];

function Settings() {
  const q = usePrefs(); const qc = useQueryClient(); const toast = useToast();
  const m = useMutation({
    mutationFn: (p: Partial<NotificationPreferences>) => api.notifications.setPrefs(p),
    onMutate: (p) => { void qc.cancelQueries({ queryKey: ['prefs'] }); const prev = qc.getQueryData<NotificationPreferences>(['prefs']); qc.setQueryData<NotificationPreferences>(['prefs'], (d) => d && { ...d, ...p }); return { prev }; },
    onError: (e, _p, ctx) => { qc.setQueryData(['prefs'], ctx?.prev); toast(errorText(e), 'error'); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['prefs'] }),
  });
  if (q.isLoading) return <Loading rows={5} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data!;
  return (
    <div className="stack">
      <div className="card" style={{ padding: 0 }}>
        <div className="pref"><Icon name="bell" /><div className="grow"><div className="strong">Push notifications</div><div className="small muted">On your phone or browser</div></div><Toggle label="Push notifications" checked={p.pushEnabled} onChange={(v) => m.mutate({ pushEnabled: v })} /></div>
        <div className="pref" style={{ borderTop: '1px solid var(--line)' }}><Icon name="mail" /><div className="grow"><div className="strong">Email reminders</div><div className="small muted">Reminders and changes by email</div></div><Toggle label="Email reminders" checked={p.emailEnabled} onChange={(v) => m.mutate({ emailEnabled: v })} /></div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {ROWS.map((r, i) => (
          <div key={r.key} className="pref" style={i ? { borderTop: '1px solid var(--line)' } : undefined}>
            <div className="grow"><div className="strong">{r.title} {r.beta && <Tag tone="brand">Beta</Tag>}</div><div className="small muted">{r.desc}</div></div>
            <Toggle label={r.title} checked={p[r.key]} onChange={(v) => m.mutate({ [r.key]: v })} />
          </div>
        ))}
      </div>
      <div className="card pref" style={{ padding: '12px 16px' }}>
        <div className="grow"><label htmlFor="lead" className="strong">Remind me before events</label><div className="small muted">How early the "coming up" reminder arrives</div></div>
        <select id="lead" className="select" style={{ width: 'auto' }} value={p.reminderLeadHours} onChange={(e) => m.mutate({ reminderLeadHours: Number(e.target.value) })}>
          {[1, 3, 6, 12, 24, 48, 72].concat(p.reminderLeadHours && ![1, 3, 6, 12, 24, 48, 72].includes(p.reminderLeadHours) ? [p.reminderLeadHours] : []).sort((a, b) => a - b).map((h) => <option key={h} value={h}>{h < 24 ? `${h} hour${h > 1 ? 's' : ''}` : `${h / 24 >= 1 && h % 24 === 0 ? `${h / 24} day${h > 24 ? 's' : ''}` : `${h} hours`}`}</option>)}
        </select>
      </div>
      <p className="hint">Smart reminders are in beta – tell us if they feel too chatty or not helpful enough.</p>
    </div>
  );
}

export function Profile() {
  const { me, isGuest, signIn, signOut } = useAuth(); const toast = useToast(); const qc = useQueryClient();
  const [f, setF] = useState({ displayName: me?.displayName ?? '', email: me?.email ?? '', password: '' }); const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  if (!me) return null;
  const upgrade = async (e: FormEvent) => {
    e.preventDefault(); const er: Record<string, string> = {};
    if (!f.displayName.trim()) er.displayName = 'Tell us your name';
    if (f.password.length < 8) er.password = 'Use at least 8 characters';
    setErrs(er); if (Object.keys(er).length) return; setBusy(true);
    try { const r = await api.auth.upgrade({ password: f.password, displayName: f.displayName.trim() }); signIn(r); qc.invalidateQueries(); toast('Account created – all your groups and tasks are still here', 'success'); }
    catch (x) { setErrs({ form: errorText(x) }); } finally { setBusy(false); }
  };
  return (
    <>
      <TopBar back={false} title="Profile" />
      <div className="page"><div className="container stack" style={{ paddingTop: 16, gap: 16 }}>
        <div className="card row"><Avatar name={me.displayName} size={64} /><div className="grow"><div className="strong" style={{ fontSize: '1.15rem' }}>{me.displayName}</div><div className="small muted">{me.email ?? ''}</div></div><Tag tone={isGuest ? 'warn' : 'brand'}>{isGuest ? 'Guest' : 'Member'}</Tag></div>
        {isGuest && (
          <form className="card stack" onSubmit={upgrade} noValidate aria-label="Create an account">
            <div><h2 style={{ fontSize: '1.1rem' }}>Create an account</h2><p className="small muted">Keep your groups, RSVPs and tasks – and unlock creating groups and events. Nothing you've done as a guest is lost.</p></div>
            {errs.form && <div className="banner" role="alert">{errs.form}</div>}
            <Field label="Your name" error={errs.displayName}>{(id, bad) => <TextInput id={id} value={f.displayName} invalid={bad} onChange={(e) => setF({ ...f, displayName: e.target.value })} />}</Field>
            <Field label="Email" hint="The address you were invited with">{(id) => <TextInput id={id} type="email" value={f.email} readOnly disabled />}</Field>
            <Field label="Choose a password" error={errs.password} hint="At least 8 characters">{(id, bad) => <TextInput id={id} type="password" autoComplete="new-password" value={f.password} invalid={bad} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</Button>
          </form>
        )}
        <div className="list card" style={{ padding: 0, overflow: 'hidden' }}>
          <Link className="item" to="/notifications"><Icon name="bell" /><span className="grow">Notifications & smart reminders</span><Icon name="chevron" size={18} /></Link>
          <Link className="item" to="/integrations"><Icon name="sync" /><span className="grow">Calendar, to-dos & messaging</span><Tag>Preview</Tag><Icon name="chevron" size={18} /></Link>
        </div>
        <Button variant="secondary" onClick={() => signOut()}><Icon name="logout" size={18} /> Sign out</Button>
      </div></div>
    </>
  );
}

/** Optional extras: interface previews only – the connections themselves are not wired to a backend yet. */
export function Integrations() {
  const [on, setOn] = useState<Record<string, boolean>>({});
  const toast = useToast();
  const items = [
    { k: 'cal', icon: 'calendar', title: 'Calendar sync', desc: 'Add events you join to Google, Apple or Outlook calendar.' },
    { k: 'todo', icon: 'tasks', title: 'To-do list sync', desc: 'Send your claimed tasks to Google Tasks, Microsoft To Do or Reminders.' },
    { k: 'wa', icon: 'chat', title: 'WhatsApp', desc: 'Share events to WhatsApp and get reminders there.' },
    { k: 'msg', icon: 'mail', title: 'Messages', desc: 'Share events by text message and get reminders by SMS.' },
  ];
  return (
    <>
      <TopBar title="Connections" />
      <div className="page"><div className="container stack" style={{ paddingTop: 16 }}>
        <div className="banner info" style={{ borderRadius: 12 }}>These are previews of upcoming integrations. Nothing is connected yet.</div>
        {items.map((i) => (
          <div key={i.k} className="card row"><span className="avatar" style={{ width: 44, height: 44, background: 'var(--brand-soft)', color: 'var(--brand)' }}><Icon name={i.icon} /></span>
            <div className="grow"><div className="strong">{i.title}</div><div className="small muted">{i.desc}</div></div>
            <Toggle label={i.title} checked={!!on[i.k]} onChange={(v) => { setOn({ ...on, [i.k]: v }); toast(v ? `${i.title}: coming soon – we'll let you know` : `${i.title} off`); }} /></div>
        ))}
      </div></div>
    </>
  );
}
