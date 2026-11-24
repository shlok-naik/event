import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Location } from '../api';
import { useAuth } from '../lib/auth';
import { useGroup, useLocations, useMembers } from '../lib/queries';
import { errorText, useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Avatar, Button, Empty, ErrorState, Field, GroupAvatar, Loading, Sheet, Tag, TextInput, TopBar } from '../components/ui';
import { LocationPicker } from '../components/LocationPicker';
import { EmailChips } from '../components/EmailChips';
import { MapView, mapsLink } from '../components/MapView';

/** Shown instead of a form when a guest opens a registered-only screen. */
export function RegisteredOnly({ what }: { what: string }) {
  return (<><TopBar title={what} /><div className="page"><Empty icon="user" title="Registered accounts only" action={<Link className="btn" to="/me">Create an account</Link>}>Guests can chat, join events and claim tasks. Create an account to {what.toLowerCase()} – you'll keep everything you've joined.</Empty></div></>);
}

export function GroupNew() {
  const { isUser } = useAuth(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast();
  const [name, setName] = useState(''); const [loc, setLoc] = useState<Location | null>(null); const [emails, setEmails] = useState<string[]>([]);
  const [image, setImage] = useState<File | null>(null); const [err, setErr] = useState<string | null>(null);
  const preview = useMemo(() => (image ? URL.createObjectURL(image) : null), [image]);
  const m = useMutation({
    mutationFn: () => api.groups.create({ name: name.trim(), location: loc, image, emails }),
    onSuccess: (g) => { qc.invalidateQueries({ queryKey: ['groups'] }); qc.invalidateQueries({ queryKey: ['locations'] }); toast(emails.length ? `Group created – ${emails.length} invitation${emails.length > 1 ? 's' : ''} sent` : 'Group created', 'success'); nav(`/groups/${g.id}`, { replace: true }); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  if (!isUser) return <RegisteredOnly what="Create a group" />;
  const pick = (f?: File) => { if (!f) return; if (!/^image\/(png|jpe?g|webp)$/.test(f.type)) return setErr('Please choose a PNG, JPEG or WebP image'); if (f.size > 2 * 1024 * 1024) return setErr('Images must be under 2 MB'); setErr(null); setImage(f); };
  const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return setErr('Give your group a name'); setErr(null); m.mutate(); };
  return (
    <>
      <TopBar title="New group" />
      <div className="page"><form className="container formpage" onSubmit={submit} noValidate>
        <div className="stack">
          <div className="row" style={{ gap: 16 }}>
            <label style={{ cursor: 'pointer', position: 'relative' }} aria-label="Choose group image">
              <GroupAvatar name={name || 'G'} src={preview} size={84} />
              <span className="avatar" style={{ position: 'absolute', right: -4, bottom: -4, width: 30, height: 30, background: 'var(--brand)' }}><Icon name="camera" size={16} /></span>
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr" onChange={(e) => pick(e.target.files?.[0])} />
            </label>
            <div className="grow"><Field label="Group name" error={err}>{(id, bad) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} invalid={bad} autoFocus placeholder="e.g. Climbing crew" />}</Field></div>
          </div>
          <Field label="Where is the group based?" hint="Optional – shown on the map to members only">{(id) => <LocationPicker id={id} value={loc} onChange={setLoc} />}</Field>
          <Field label="Invite people by email" hint="Add several addresses – they'll get a link and can join without signing up">{(id) => <EmailChips id={id} value={emails} onChange={setEmails} />}</Field>
          <Button type="submit" block disabled={m.isPending}>{m.isPending ? 'Creating…' : emails.length ? `Create group & invite ${emails.length}` : 'Create group'}</Button>
        </div>
      </form></div>
    </>
  );
}

export function GroupInfo() {
  const { id = '' } = useParams(); const nav = useNavigate(); const { me } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const g = useGroup(id); const members = useMembers(id);
  const [emails, setEmails] = useState<string[]>([]); const [leave, setLeave] = useState(false);
  const invite = useMutation({
    mutationFn: () => api.groups.invite(id, emails),
    onSuccess: (r) => { toast(`Invitation${r.length > 1 ? 's' : ''} sent to ${r.filter((x) => x.result === 'sent').length || r.length}`, 'success'); setEmails([]); qc.invalidateQueries({ queryKey: ['members', id] }); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const leaveM = useMutation({
    mutationFn: () => api.groups.leave(id, me!.id),
    onSuccess: () => { qc.invalidateQueries(); toast('You left the group'); nav('/', { replace: true }); },
    onError: (e) => toast(errorText(e), 'error'),
  });
  if (g.isLoading) return <><TopBar title="Group info" /><Loading /></>;
  if (g.isError) return <><TopBar title="Group info" /><ErrorState error={g.error} onRetry={() => g.refetch()} /></>;
  const grp = g.data!; const admin = grp.myRole !== 'member';
  return (
    <>
      <TopBar title="Group info" back={`/groups/${id}`} />
      <div className="page"><div className="container stack" style={{ paddingTop: 16, gap: 20 }}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', gap: 8 }}>
          <GroupAvatar name={grp.name} src={grp.imageUrl} size={96} /><h2 style={{ fontSize: '1.4rem' }}>{grp.name}</h2>
          <p className="muted small">{grp.memberCount} members</p>
          <Link className="btn secondary small" to={`/groups/${id}`}><Icon name="chat" size={18} /> Open chat</Link>
        </div>
        {grp.location && (
          <section className="card stack" style={{ gap: 8 }} aria-label="Group location">
            <div className="row"><Icon name="pin" /><div className="grow"><div className="strong">{grp.location.name ?? 'Location'}</div>{grp.location.address && <div className="small muted">{grp.location.address}</div>}</div></div>
            <MapView height={160} markers={[{ id: grp.id, lat: grp.location.lat, lng: grp.location.lng, label: grp.name }]} label="Group map" />
            <a className="small" href={mapsLink(grp.location.lat, grp.location.lng)} target="_blank" rel="noreferrer">Open in Google Maps</a>
          </section>
        )}
        <section aria-labelledby="mem">
          <h2 id="mem" className="label" style={{ marginBottom: 6 }}>MEMBERS</h2>
          {members.isLoading ? <Loading rows={3} /> : members.isError ? <ErrorState error={members.error} onRetry={() => members.refetch()} /> : (
            <div className="list card" style={{ padding: 0, overflow: 'hidden' }}>
              {members.data!.map((m) => (
                <div className="item" key={m.id} data-testid="member">
                  <Avatar name={m.displayName} size={42} />
                  <div className="grow"><div className="strong ellipsis">{m.displayName}{m.id === me?.id && ' (you)'}</div>{m.email && <div className="small muted ellipsis">{m.email}</div>}</div>
                  {m.kind === 'guest' && <Tag>Guest</Tag>}{m.role !== 'member' && <Tag tone="brand">{m.role}</Tag>}
                </div>
              ))}
            </div>
          )}
        </section>
        {admin && (
          <section className="card stack" aria-label="Invite people">
            <Field label="Invite more people" hint="Enter email addresses – each gets a personal join link">{(i) => <EmailChips id={i} value={emails} onChange={setEmails} />}</Field>
            <Button disabled={!emails.length || invite.isPending} onClick={() => invite.mutate()}>{invite.isPending ? 'Sending…' : `Send ${emails.length || ''} invitation${emails.length === 1 ? '' : 's'}`}</Button>
          </section>
        )}
        {grp.myRole !== 'owner' && <Button variant="secondary" style={{ color: 'var(--danger)' }} onClick={() => setLeave(true)}>Leave group</Button>}
      </div></div>
      {leave && <Sheet title="Leave this group?" onClose={() => setLeave(false)}><p className="muted" style={{ marginBottom: 16 }}>You'll stop seeing its chat and events, and your RSVPs and task claims for its events are released.</p>
        <div className="row"><Button variant="secondary" className="grow" onClick={() => setLeave(false)}>Stay</Button><Button variant="danger" className="grow" disabled={leaveM.isPending} onClick={() => leaveM.mutate()}>Leave</Button></div></Sheet>}
    </>
  );
}

export function MapPage() {
  const nav = useNavigate(); const q = useLocations();
  const markers = (q.data ?? []).map((l) => ({ id: l.groupId, lat: l.location.lat, lng: l.location.lng, label: l.name }));
  return (
    <>
      <TopBar back={false} title="Map" subtitle="Where your groups are based" />
      <div className="page"><div className="container" style={{ paddingTop: 12 }}>
        {q.isLoading ? <Loading rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : markers.length === 0 ? (
          <Empty icon="map" title="No group locations yet">Groups you belong to appear here once a location is set.</Empty>
        ) : (
          <div className="stack">
            <MapView markers={markers} height={340} onSelect={(id) => nav(`/groups/${id}`)} label="Map of your groups" />
            <div className="list card" style={{ padding: 0, overflow: 'hidden' }}>
              {q.data!.map((l) => (
                <Link key={l.groupId} to={`/groups/${l.groupId}`} className="item"><GroupAvatar name={l.name} src={l.imageUrl} size={42} />
                  <div className="grow"><div className="strong ellipsis">{l.name}</div><div className="small muted ellipsis">{l.location.name ?? l.location.address}</div></div><Icon name="chevron" size={18} /></Link>
              ))}
            </div>
          </div>
        )}
      </div></div>
    </>
  );
}
