import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Message } from '../api';
import { useAuth } from '../lib/auth';
import { useGroup, usePinned } from '../lib/queries';
import { useNow } from '../lib/hooks';
import { isGone } from '../lib/lifecycle';
import { colorFor, dayLabel, timeOf } from '../lib/format';
import { errorText, useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Button, Empty, ErrorState, GroupAvatar, IconButton, Loading, TopBar } from '../components/ui';
import { EventMessage, PinnedCard } from '../components/EventBits';

type MsgData = { messages: Message[]; hasMore: boolean };

export function Chat() {
  const { id = '' } = useParams();
  const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast(); const { me, isUser } = useAuth();
  const group = useGroup(id);
  const msgs = useQuery({ queryKey: ['messages', id], queryFn: () => api.groups.messages(id) });
  const pinned = usePinned(id);
  const now = useNow();
  const [text, setText] = useState(''); const [older, setOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null); const stick = useRef(true); const ta = useRef<HTMLTextAreaElement>(null);

  const send = useMutation({
    mutationFn: (body: string) => api.groups.send(id, body),
    onSuccess: (m) => { qc.setQueryData<MsgData>(['messages', id], (d) => d && (d.messages.some((x) => x.id === m.id) ? d : { ...d, messages: [...d.messages, m] })); qc.invalidateQueries({ queryKey: ['groups'] }); stick.current = true; },
    onError: (e, body) => { toast(errorText(e), 'error'); setText(body); },
  });
  const submit = () => { const b = text.trim(); if (!b || send.isPending) return; setText(''); send.mutate(b); ta.current?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } };
  useEffect(() => { if (ta.current) { ta.current.style.height = 'auto'; ta.current.style.height = Math.min(ta.current.scrollHeight, 120) + 'px'; } }, [text]);

  // read receipts: mark the group read whenever new messages arrive while open
  const lastId = msgs.data?.messages.at(-1)?.id;
  useEffect(() => { if (lastId) api.groups.markRead(id, lastId).then(() => qc.invalidateQueries({ queryKey: ['groups'] })).catch(() => {}); }, [id, lastId, qc]);

  const list = useMemo(() => (msgs.data?.messages ?? []).filter((m) => !(m.type === 'event' && (!m.event || isGone(m.event, now)))), [msgs.data, now]);
  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [list.length, pinned.data?.length]);
  const onScroll = () => { const el = scroller.current!; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; };

  const loadOlder = async () => {
    const first = msgs.data?.messages[0]; if (!first) return; setOlder(true);
    try { const r = await api.groups.messages(id, first.id); qc.setQueryData<MsgData>(['messages', id], (d) => d && { hasMore: r.hasMore, messages: [...r.messages, ...d.messages] }); stick.current = false; }
    catch (e) { toast(errorText(e), 'error'); } finally { setOlder(false); }
  };

  if (group.isError) return <><TopBar title="Group" /><ErrorState error={group.error} onRetry={() => group.refetch()} /><div className="center"><Button variant="secondary" onClick={() => nav('/')}>Back to chats</Button></div></>;
  const g = group.data;
  const pins = (pinned.data ?? []).filter((e) => !isGone(e, now) && Date.parse(e.endsAt ?? e.startsAt) + (e.endsAt ? 0 : 3 * 3_600_000) > now);

  return (
    <>
      <TopBar
        title={g?.name ?? '…'} subtitle={g ? `${g.memberCount} members · tap for info` : undefined} onTitleClick={() => nav(`/groups/${id}/info`)}
        right={<>{isUser && <Link className="iconbtn" to={`/events/new?groupId=${id}`} aria-label="New event in this group" title="New event"><Icon name="calendar" /></Link>}<IconButton icon="users" label="Group info" onClick={() => nav(`/groups/${id}/info`)} /></>}
      />
      <div className="chat">
        {pins.length > 0 && (
          <section className="pinned-strip" aria-label="Pinned upcoming events" data-testid="pinned">
            <div className="lbl"><Icon name="pin" size={13} /> Pinned events</div>
            <div className="hscroll" style={{ paddingBottom: 8 }}>{pins.map((e) => <PinnedCard key={e.id} event={e} />)}</div>
          </section>
        )}
        <div className="chat-scroll" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label="Messages">
          {msgs.isLoading && <Loading rows={5} />}
          {msgs.isError && <ErrorState error={msgs.error} onRetry={() => msgs.refetch()} />}
          {msgs.data?.hasMore && <Button small variant="secondary" style={{ alignSelf: 'center' }} onClick={loadOlder} disabled={older}>{older ? 'Loading…' : 'Load earlier messages'}</Button>}
          {msgs.data && list.length === 0 && <Empty icon="chat" title="Say hello 👋">This is the start of the conversation. Messages and events appear here.</Empty>}
          {list.map((m, i) => {
            const prev = list[i - 1];
            const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            const mine = m.sender?.id === me?.id;
            const showName = !mine && m.type === 'text' && (newDay || prev?.sender?.id !== m.sender?.id || prev?.type !== 'text');
            return (
              <Fragment key={m.id}>
                {newDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
                {m.type === 'system' ? <div className="sys">{m.body}</div>
                  : m.type === 'event' && m.event ? <EventMessage event={m.event} />
                  : (
                    <div className={`bubble ${mine ? 'out' : ''}`} style={{ marginTop: showName ? 6 : 0 }}>
                      {showName && <div className="who" style={{ color: colorFor(m.sender?.id ?? '') }}>{m.sender?.displayName}{m.sender?.kind === 'guest' && <span className="tiny muted"> · guest</span>}</div>}
                      <span className="txt">{m.body}</span><span className="ts">{timeOf(m.createdAt)}</span>
                    </div>
                  )}
              </Fragment>
            );
          })}
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <textarea ref={ta} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Message" aria-label="Message" maxLength={4000} />
          <button className="sendbtn" type="submit" aria-label="Send" disabled={!text.trim() || send.isPending}><Icon name="send" size={22} fill /></button>
        </form>
      </div>
    </>
  );
}
