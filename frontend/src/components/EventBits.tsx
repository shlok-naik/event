import { Link } from 'react-router-dom';
import type { EventSummary } from '../api';
import { useRsvp } from '../lib/queries';
import { useNow } from '../lib/hooks';
import { hasEnded, isLive } from '../lib/lifecycle';
import { plural, relative, when } from '../lib/format';
import { Icon } from './Icon';
import { Button, Progress, Tag } from './ui';

/** Join / Going toggle used everywhere an event appears – one tap to join. */
export function JoinButton({ event, small = true }: { event: EventSummary; small?: boolean }) {
  const rsvp = useRsvp();
  const going = event.myRsvp === 'going';
  if (event.status === 'cancelled') return <Tag tone="danger">Cancelled</Tag>;
  const busy = rsvp.isPending && rsvp.variables?.id === event.id;
  if (going) return <Button small={small} variant="joined" disabled={busy} onClick={() => rsvp.mutate({ id: event.id, join: false })} aria-label={`You're going to ${event.name}. Tap to leave`}>{busy ? '…' : '✓ Going'}</Button>;
  if (event.full) return <Button small={small} variant="secondary" disabled>Full</Button>;
  return <Button small={small} disabled={busy} onClick={() => rsvp.mutate({ id: event.id, join: true })} aria-label={`Join ${event.name}`}>{busy ? 'Joining…' : 'Join'}</Button>;
}

export function Headcount({ event }: { event: EventSummary }) {
  const { goingCount: n, minParticipants: min, maxParticipants: max } = event;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <Progress value={n} max={Math.max(min, 1)} ok={event.minimumMet} />
      <div className="tiny muted">
        {plural(n, 'person', 'people')} going · {event.minimumMet ? 'minimum reached ✓' : `needs ${min - n} more`}{max ? ` · max ${max}` : ''}
      </div>
    </div>
  );
}

/** Card for horizontal "up next" lists and grids. */
export function EventCard({ event }: { event: EventSummary }) {
  const now = useNow();
  return (
    <div className="evcard">
      <Link to={`/events/${event.id}`} style={{ color: 'inherit' }} className="stack" aria-label={`Open ${event.name}`}>
        <div className="row"><h3 className="grow ellipsis">{event.name}</h3>{event.status === 'cancelled' && <Tag tone="danger">Cancelled</Tag>}</div>
        <div className="small"><Icon name="clock" size={14} /> {when(event.startsAt)} {isLive(event, now) ? <Tag tone="brand">Happening now</Tag> : <span className="muted">· {relative(event.startsAt, now)}</span>}</div>
        {event.location?.name && <div className="small muted ellipsis"><Icon name="pin" size={14} /> {event.location.name}</div>}
        <Headcount event={event} />
      </Link>
      <div className="row">
        {event.taskCounts.total > 0 && <Tag tone={event.taskCounts.unassigned === 0 ? 'ok' : 'warn'}>{event.taskCounts.unassigned === 0 ? 'All tasks taken' : `${plural(event.taskCounts.unassigned, 'task')} open`}</Tag>}
        <span className="grow" /><JoinButton event={event} />
      </div>
    </div>
  );
}

/** Compact card for the pinned strip at the top of a group chat. */
export function PinnedCard({ event }: { event: EventSummary }) {
  return (
    <div className="evcard pinned">
      <Link to={`/events/${event.id}`} style={{ color: 'inherit' }} aria-label={`Open ${event.name}`}>
        <div className="strong ellipsis">{event.name}</div>
        <div className="small muted ellipsis">{when(event.startsAt)}</div>
      </Link>
      <div className="row"><span className="tiny muted grow">{event.goingCount}/{event.minParticipants}+ going</span><JoinButton event={event} /></div>
    </div>
  );
}

/** Interactive event card rendered inside the message list. */
export function EventMessage({ event }: { event: EventSummary }) {
  const now = useNow();
  const ended = hasEnded(event, now);
  return (
    <div className={`evmsg ${ended ? 'ended' : ''} ${event.status}`} data-testid="event-message">
      <div className="row"><Icon name="calendar" size={18} /><span className="tiny strong muted grow">NEW EVENT</span>{ended && <Tag>Ended</Tag>}{event.status === 'cancelled' && <Tag tone="danger">Cancelled</Tag>}</div>
      <Link to={`/events/${event.id}`} className="stack" style={{ gap: 4, color: 'inherit' }}>
        <h3 style={{ fontSize: '1.05rem' }}>{event.name}</h3>
        <div className="small"><Icon name="clock" size={14} /> {when(event.startsAt)}</div>
        {event.location?.name && <div className="small muted"><Icon name="pin" size={14} /> {event.location.name}</div>}
      </Link>
      <Headcount event={event} />
      {!ended && <div className="row"><JoinButton event={event} small={false} /><Link to={`/events/${event.id}`} className="btn secondary small">Details</Link></div>}
    </div>
  );
}
