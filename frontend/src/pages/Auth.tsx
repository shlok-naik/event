import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, API_MODE, ApiError, resetMockData } from '../api';
import { Sheet } from '../components/ui';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/Logo';
import { Avatar, Button, ErrorState, Field, Spinner, TextInput } from '../components/ui';

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export function Login() {
  const { me, signIn, loading } = useAuth();
  const [sp] = useSearchParams();
  const next = safeNext(sp.get('next'));
  const nav = useNavigate();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [errs, setErrs] = useState<{ email?: string; password?: string; form?: string }>({}); const [busy, setBusy] = useState(false); const [link, setLink] = useState(false);
  if (loading) return <div className="center-screen"><Spinner /></div>;
  if (me) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const er: typeof errs = {};
    if (!emailRe.test(email)) er.email = 'Enter a valid email address';
    if (!password) er.password = 'Enter your password';
    setErrs(er); if (Object.keys(er).length) return;
    setBusy(true);
    try { signIn(await api.auth.login({ email: email.trim(), password })); nav(next, { replace: true }); }
    catch (x) { setErrs({ form: x instanceof Error ? x.message : 'Could not sign in' }); } finally { setBusy(false); }
  };
  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={submit} noValidate aria-labelledby="t">
        <Logo /><div><h1 id="t" style={{ fontSize: '1.5rem' }}>Welcome back</h1><p className="muted">Sign in to see your groups and events.</p></div>
        {errs.form && <div className="banner" role="alert">{errs.form}</div>}
        <Field label="Email" error={errs.email}>{(id, bad) => <TextInput id={id} type="email" autoComplete="email" inputMode="email" value={email} invalid={bad} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
        <Field label="Password" error={errs.password}>{(id, bad) => <TextInput id={id} type="password" autoComplete="current-password" value={password} invalid={bad} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" disabled={busy} block>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <p className="small muted" style={{ textAlign: 'center' }}>New here? <Link to={`/signup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>Create an account</Link><br />
          Joined as a guest? <button type="button" className="btn ghost small" onClick={() => setLink(true)}>Email me a sign-in link</button></p>
        {link && <GuestLinkSheet initial={email} onClose={() => setLink(false)} />}
        {API_MODE === 'mock' && (
          <div className="stat"><div className="small"><b>Demo mode</b> – no server needed.<br />
            <button type="button" className="btn ghost small" onClick={() => { setEmail('alice@example.com'); setPassword('password123'); }}>Fill demo login</button>
            <Link className="btn ghost small" to="/invite?token=guest-demo">Try as an invited guest</Link>
            <button type="button" className="btn ghost small" onClick={() => { resetMockData(); location.reload(); }}>Reset demo data</button></div></div>
        )}
      </form>
    </div>
  );
}

export function Signup() {
  const { me, signIn, loading } = useAuth();
  const [sp] = useSearchParams(); const next = safeNext(sp.get('next')); const nav = useNavigate();
  const [f, setF] = useState({ displayName: '', email: '', password: '' });
  const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  if (loading) return <div className="center-screen"><Spinner /></div>;
  if (me) return <Navigate to={next} replace />;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!f.displayName.trim()) er.displayName = 'Tell us your name';
    if (!emailRe.test(f.email)) er.email = 'Enter a valid email address';
    if (f.password.length < 8) er.password = 'Use at least 8 characters';
    setErrs(er); if (Object.keys(er).length) return;
    setBusy(true);
    try { signIn(await api.auth.register({ ...f, displayName: f.displayName.trim(), email: f.email.trim() })); nav(next, { replace: true }); }
    catch (x) { setErrs(x instanceof ApiError && x.code === 'email_taken' ? { email: x.message } : { form: x instanceof Error ? x.message : 'Could not sign up' }); } finally { setBusy(false); }
  };
  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={submit} noValidate aria-labelledby="t">
        <Logo /><div><h1 id="t" style={{ fontSize: '1.5rem' }}>Create your account</h1><p className="muted">Start groups, plan events, get things done together.</p></div>
        {errs.form && <div className="banner" role="alert">{errs.form}</div>}
        <Field label="Your name" error={errs.displayName}>{(id, bad) => <TextInput id={id} autoComplete="name" value={f.displayName} invalid={bad} onChange={set('displayName')} autoFocus />}</Field>
        <Field label="Email" error={errs.email}>{(id, bad) => <TextInput id={id} type="email" autoComplete="email" inputMode="email" value={f.email} invalid={bad} onChange={set('email')} />}</Field>
        <Field label="Password" error={errs.password} hint="At least 8 characters">{(id, bad) => <TextInput id={id} type="password" autoComplete="new-password" value={f.password} invalid={bad} onChange={set('password')} />}</Field>
        <Button type="submit" disabled={busy} block>{busy ? 'Creating…' : 'Sign up'}</Button>
        <p className="small muted" style={{ textAlign: 'center' }}>Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </div>
  );
}

/** Landing page for email invitation links: join as a guest (no account) or log in first. */
export function Join() {
  const { token: tp } = useParams(); const [sp] = useSearchParams(); const token = tp ?? sp.get('token') ?? '';
  const { me, signIn, loading } = useAuth();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['invite', token], queryFn: () => api.invitations.preview(token), retry: false });
  const [name, setName] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (loading || q.isLoading) return <div className="center-screen"><Spinner /></div>;
  if (q.isError) return (
    <div className="center-screen"><div className="auth-card"><Logo />
      <ErrorState error={new Error((q.error as Error).message || 'This invitation link is not valid')} />
      <Link to="/" className="btn secondary block">Go to the app</Link></div></div>
  );
  const inv = q.data!;
  const join = async (e: FormEvent) => {
    e.preventDefault();
    if (!me && !inv.loginRequired && !name.trim()) return setErr('Tell us your name so the group knows who you are');
    setBusy(true); setErr(null);
    try {
      const r = await api.invitations.accept(token, name.trim() || undefined);
      if (r.auth) signIn(r.auth);
      nav(`/groups/${r.group.id}`, { replace: true });
    } catch (x) {
      if (x instanceof ApiError && x.code === 'login_required') setErr('This email already has an account – please log in to join.');
      else setErr(x instanceof Error ? x.message : 'Could not join');
    } finally { setBusy(false); }
  };
  const mustLogin = inv.loginRequired && !me;
  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={join} aria-labelledby="t" noValidate>
        <div style={{ textAlign: 'center' }} className="stack"><div style={{ margin: '0 auto' }}><Avatar name={inv.groupName} src={inv.groupImageUrl} size={84} /></div>
          <div><p className="muted small">{inv.invitedBy} invited you to join</p><h1 id="t" style={{ fontSize: '1.5rem' }}>{inv.groupName}</h1></div></div>
        {inv.expired && <div className="banner" role="alert">This invitation has expired. Ask {inv.invitedBy} to send a new one.</div>}
        {err && <div className="banner" role="alert">{err}</div>}
        {!inv.expired && (mustLogin ? (
          <Link className="btn block" to={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`}>Log in to join</Link>
        ) : me ? (
          <Button type="submit" block disabled={busy}>{busy ? 'Joining…' : `Join as ${me.displayName}`}</Button>
        ) : (
          <>
            <Field label="Your name" hint={`No account needed – you'll join as a guest (${inv.email}).`}>{(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />}</Field>
            <Button type="submit" block disabled={busy}>{busy ? 'Joining…' : 'Join group'}</Button>
            <p className="small muted" style={{ textAlign: 'center' }}>Have an account? <Link to={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`}>Log in</Link></p>
          </>
        ))}
      </form>
    </div>
  );
}

function GuestLinkSheet({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [email, setEmail] = useState(emailRe.test(initial) ? initial : ''); const [sent, setSent] = useState(false); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!emailRe.test(email)) return setErr('Enter the email address you were invited with');
    setBusy(true); setErr(null);
    try { await api.auth.requestGuestLink(email.trim()); setSent(true); } catch (x) { setErr(x instanceof Error ? x.message : 'Could not send the link'); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Sign in as a guest" onClose={onClose}>
      {sent ? <div className="stack"><p>If that address has guest access, a one-time sign-in link is on its way. It works for 30 minutes.</p><Button onClick={onClose}>Done</Button></div> : (
        <form className="stack" onSubmit={submit} noValidate>
          <p className="small muted">Use the email address your invitation was sent to. We'll send a one-time link – no password needed.</p>
          <Field label="Invited email" error={err}>{(id, bad) => <TextInput id={id} type="email" value={email} invalid={bad} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
          <Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send sign-in link'}</Button>
        </form>)}
    </Sheet>
  );
}

/** Target of the guest magic-link email: /guest-login?token=… */
export function GuestLogin() {
  const [sp] = useSearchParams(); const { signIn } = useAuth(); const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = sp.get('token'); if (!t) { setErr('This sign-in link is not valid'); return; }
    let live = true;
    api.auth.guestSession(t).then((r) => { if (live) { signIn(r); nav('/', { replace: true }); } }).catch((e) => live && setErr(e instanceof Error ? e.message : 'This sign-in link has expired'));
    return () => { live = false; };
  }, [sp, signIn, nav]);
  return (
    <div className="center-screen"><div className="auth-card"><Logo />
      {err ? <><ErrorState error={new Error(err)} /><Link className="btn block" to="/login">Request a new link</Link></> : <div className="stack" style={{ alignItems: 'center' }}><Spinner label="Signing you in" /><p className="muted">Signing you in…</p></div>}
    </div></div>
  );
}
