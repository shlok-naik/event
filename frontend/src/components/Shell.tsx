import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useGroups, useNotifications } from '../lib/queries';
import { listStamp } from '../lib/format';
import type { Group } from '../api';
import { Icon } from './Icon';
import { Avatar, Badge, Empty, ErrorState, GroupAvatar, IconButton, Loading, Sheet } from './ui';

const TOP = ['/', '/map', '/tasks', '/notifications', '/me', '/integrations'];

function preview(g: Group, myId?: string) {
  const m = g.lastMessage;
  if (!m) return 'No messages yet';
  if (m.type === 'event') return `📅 ${m.event?.name ?? m.body}`;
  if (m.type === 'system') return m.body;
  return `${m.sender?.id === myId ? 'You' : m.sender?.displayName.split(' ')[0]}: ${m.body}`;
}

export function GroupList() {
  const { me } = useAuth();
  const q = useGroups();
  const active = useMatch('/groups/:id/*')?.params.id;
  if (q.isLoading) return <Loading rows={5} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data!.length)
    return <Empty icon="users" title="No groups yet" action={me?.kind === 'user' ? <Link className="btn" to="/groups/new">Create your first group</Link> : undefined}>
      {me?.kind === 'user' ? 'Groups are where chats and events live.' : 'Ask a friend to invite you to a group by email.'}
    </Empty>;
  return (
    <div className="list" aria-label="Your groups">
      {q.data!.map((g) => (
        <Link key={g.id} to={`/groups/${g.id}`} className={`item ${active === g.id ? 'active' : ''}`} aria-label={`${g.name}${g.unreadCount ? `, ${g.unreadCount} unread` : ''}`}>
          <GroupAvatar name={g.name} src={g.imageUrl} />
          <div className="grow"><div className="strong ellipsis">{g.name}</div><div className={`small ellipsis ${g.unreadCount ? '' : 'muted'}`} style={g.unreadCount ? { fontWeight: 600 } : undefined}>{preview(g, me?.id)}</div></div>
          <div className="meta"><span className={`tiny ${g.unreadCount ? '' : 'muted'}`} style={g.unreadCount ? { color: 'var(--brand)', fontWeight: 600 } : undefined}>{g.lastMessage ? listStamp(g.lastMessage.createdAt) : ''}</span><Badge n={g.unreadCount} /></div>
        </Link>
      ))}
    </div>
  );
}

/** "+" menu: new group / new event. Registered users only. */
export function CreateMenu({ fab }: { fab?: boolean }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const { isUser } = useAuth();
  if (!isUser) return null;
  const go = (to: string) => { setOpen(false); nav(to); };
  return (
    <>
      {fab ? <button className="fab mobile-only" aria-label="Create" onClick={() => setOpen(true)}><Icon name="plus" size={28} /></button> : <IconButton icon="plus" label="Create" onClick={() => setOpen(true)} />}
      {open && (
        <Sheet title="Create" onClose={() => setOpen(false)}>
          <div className="stack" style={{ gap: 8 }}>
            <button className="item card" onClick={() => go('/events/new')}><Icon name="calendar" /><div className="grow"><div className="strong">New event</div><div className="small muted">Send it to one or more groups</div></div></button>
            <button className="item card" onClick={() => go('/groups/new')}><Icon name="users" /><div className="grow"><div className="strong">New group</div><div className="small muted">Invite people by email</div></div></button>
          </div>
        </Sheet>
      )}
    </>
  );
}

function useUnread() {
  const g = useGroups(); const n = useNotifications();
  return { chats: (g.data ?? []).reduce((a, x) => a + x.unreadCount, 0), alerts: n.data?.unreadCount ?? 0 };
}

const NAV = [{ to: '/', icon: 'chat', label: 'Chats' }, { to: '/map', icon: 'map', label: 'Map' }, { to: '/tasks', icon: 'tasks', label: 'Tasks' }, { to: '/notifications', icon: 'bell', label: 'Alerts' }];

export function Shell() {
  const { me } = useAuth();
  const loc = useLocation();
  const top = TOP.includes(loc.pathname);
  const u = useUnread();
  const badge = (to: string) => (to === '/' ? u.chats : to === '/notifications' ? u.alerts : 0);
  return (
    <div className={`shell ${top ? 'top' : 'detail'}`}>
      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebar-head">
          <Link to="/me" aria-label="Profile"><Avatar name={me?.displayName ?? '?'} size={38} /></Link>
          <span className="grow">Gather</span>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end className={({ isActive }) => `iconbtn nav-ic ${isActive ? 'active' : ''}`} aria-label={n.label} title={n.label}>
              <Icon name={n.icon} />{badge(n.to) > 0 && <span className="badge dot" style={{ borderColor: 'var(--surface-2)' }} />}
            </NavLink>
          ))}
          <CreateMenu />
        </div>
        <div className="list"><GroupList /></div>
      </aside>
      <main className="main"><Outlet /></main>
      {top && (
        <nav className="bottomnav" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="pill"><Icon name={n.icon} size={22} />{badge(n.to) > 0 && <span className="badge" style={{ position: 'absolute', top: -4, right: 6, minWidth: 18, height: 18 }}>{badge(n.to)}</span>}</span>{n.label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
