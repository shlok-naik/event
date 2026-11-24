import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useEvents, useMyTasks } from '../lib/queries';
import { useNow } from '../lib/hooks';
import { isUpcoming } from '../lib/lifecycle';
import { Avatar, ErrorState, Loading, TopBar } from '../components/ui';
import { CreateMenu, GroupList } from '../components/Shell';
import { EventCard } from '../components/EventBits';
import { TaskRow } from '../components/TaskRow';
import { Icon } from '../components/Icon';

export function Home() {
  const { me, isGuest } = useAuth();
  const events = useEvents(); const tasks = useMyTasks();
  const now = useNow();
  const allUpcoming = (events.data ?? []).filter((e) => isUpcoming(e, now));
  const upcoming = allUpcoming.slice(0, 8);
  const liveIds = new Set(allUpcoming.map((e) => e.id));
  // tasks of events that have ended disappear with them
  const open = (tasks.data ?? []).filter((t) => (events.data ? liveIds.has(t.event.id) : true) && t.event.status === 'active');
  return (
    <>
      <TopBar back={false} title="Gather" subtitle={`Hi ${me?.displayName.split(' ')[0]}`} right={<Link to="/me" className="iconbtn" aria-label="Profile"><Avatar name={me?.displayName ?? '?'} size={34} /></Link>} />
      <div className="page">
        {isGuest && <div className="banner info"><Icon name="user" size={18} /><span className="grow">You're a guest – you can chat, join events and claim tasks in groups you're invited to.</span><Link to="/me">Create account</Link></div>}

        <section className="section" aria-labelledby="up">
          <h2 id="up">Upcoming events</h2>
          {events.isLoading ? <Loading rows={2} /> : events.isError ? <ErrorState error={events.error} onRetry={() => events.refetch()} /> :
            upcoming.length === 0 ? <div className="card" style={{ margin: '0 16px' }}><p className="muted small">No upcoming events. {me?.kind === 'user' ? <>Tap <b>+</b> to plan one.</> : 'Events from your groups will show up here.'}</p></div> :
            <div className="hscroll">{upcoming.map((e) => <EventCard key={e.id} event={e} />)}</div>}
        </section>

        <section className="section" aria-labelledby="tk">
          <h2 id="tk">Your tasks {open.length > 0 && <Link to="/tasks">See all ({open.length})</Link>}</h2>
          {tasks.isLoading ? <Loading rows={2} /> : tasks.isError ? <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} /> :
            open.length === 0 ? <div className="card" style={{ margin: '0 16px' }}><p className="muted small">Nothing to do right now 🎉 Claim a task on an event to see it here.</p></div> :
            <div className="card" style={{ margin: '0 16px', padding: '4px 14px' }}>{open.slice(0, 3).map((t) => <TaskRow key={t.id} task={t} showEvent />)}</div>}
        </section>

        <section className="section mobile-only" aria-labelledby="gr">
          <h2 id="gr">Groups</h2>
          <GroupList />
        </section>
      </div>
      <CreateMenu fab />
    </>
  );
}
