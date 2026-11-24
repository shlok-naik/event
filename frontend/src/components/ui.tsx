import { useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icon';
import { colorFor, initials } from '../lib/format';

export function Button({ variant, small, block, className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'secondary' | 'ghost' | 'danger' | 'joined'; small?: boolean; block?: boolean }) {
  return <button {...p} className={`btn ${variant ?? ''} ${small ? 'small' : ''} ${block ? 'block' : ''} ${className}`} />;
}
export function IconButton({ icon, label, badge, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; badge?: boolean }) {
  return <button {...p} className={`iconbtn ${p.className ?? ''}`} aria-label={label} title={label}><Icon name={icon} />{badge && <span className="badge dot" />}</button>;
}

export function Avatar({ name, src, size = 48 }: { name: string; src?: string | null; size?: number }) {
  return (
    <span className="avatar" role="img" aria-label={name} style={{ width: size, height: size, fontSize: size * 0.38, backgroundColor: src ? 'var(--surface-2)' : colorFor(name), backgroundImage: src ? `url(${src})` : undefined }}>
      {!src && initials(name)}
    </span>
  );
}
export function GroupAvatar({ name, src, size = 52 }: { name: string; src?: string | null; size?: number }) {
  return <Avatar name={name} src={src} size={size} />;
}

export function Badge({ n }: { n: number }) { return n > 0 ? <span className="badge" aria-label={`${n} unread`}>{n > 99 ? '99+' : n}</span> : null; }

export function Tag({ tone, children }: { tone?: 'ok' | 'warn' | 'brand' | 'danger'; children: ReactNode }) { return <span className={`pill-tag ${tone ?? ''}`}>{children}</span>; }

export function Field({ label, error, hint, children }: { label: string; error?: string | null; hint?: string; children: (id: string, invalid: boolean) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, !!error)}
      {error ? <span className="err" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}
export const TextInput = ({ invalid, ...p }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) => <input {...p} className={`input ${p.className ?? ''}`} aria-invalid={invalid || undefined} />;
export const TextArea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`textarea ${p.className ?? ''}`} />;

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const [v, setV] = useState(checked);   // optimistic: flips instantly, re-syncs when the prop changes (e.g. rollback)
  useEffect(() => setV(checked), [checked]);
  return <input type="checkbox" role="switch" className="toggle" checked={v} disabled={disabled} aria-label={label} onChange={(e) => { setV(e.target.checked); onChange(e.target.checked); }} />;
}

export function Stepper({ value, onChange, min = 1, max = 999, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label}`} onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label={`Increase ${label}`} onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>+</button>
    </div>
  );
}

export function Progress({ value, max, ok }: { value: number; max: number; ok?: boolean }) {
  return <div className={`progress ${ok ? 'ok' : ''}`} role="progressbar" aria-valuenow={value} aria-valuemax={max}><i style={{ width: `${Math.min(100, (value / Math.max(1, max)) * 100)}%` }} /></div>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) { return <div className="spinner" role="status" aria-label={label} />; }
export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ padding: 16, display: 'grid', gap: 14 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row"><div className="skel" style={{ width: 48, height: 48, borderRadius: '50%' }} /><div className="grow" style={{ display: 'grid', gap: 8 }}><div className="skel" style={{ height: 14, width: '55%' }} /><div className="skel" style={{ height: 12, width: '85%' }} /></div></div>
      ))}
    </div>
  );
}
export function Empty({ icon = 'chat', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="ic"><Icon name={icon} size={30} /></div><h2 style={{ fontSize: '1.05rem', color: 'var(--text)' }}>{title}</h2>{children && <p className="small">{children}</p>}{action}</div>;
}
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="empty" role="alert">
      <div className="ic" style={{ color: 'var(--danger)' }}><Icon name="close" size={30} /></div>
      <h2 style={{ fontSize: '1.05rem', color: 'var(--text)' }}>Couldn't load this</h2>
      <p className="small">{error instanceof Error ? error.message : 'Something went wrong.'}</p>
      {onRetry && <Button variant="secondary" small onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <div className="row" style={{ marginBottom: 8 }}><h2 className="grow" style={{ fontSize: '1.1rem' }}>{title}</h2><IconButton icon="close" label="Close" onClick={onClose} /></div>
        {children}
      </div>
    </div>
  );
}

export function TopBar({ title, subtitle, back = true, right, onTitleClick }: { title: ReactNode; subtitle?: ReactNode; back?: boolean | string; right?: ReactNode; onTitleClick?: () => void }) {
  const nav = useNavigate();
  return (
    <header className="topbar">
      {back && <IconButton icon="back" label="Back" onClick={() => (typeof back === 'string' ? nav(back) : window.history.length > 1 ? nav(-1) : nav('/'))} />}
      <div className="titles" onClick={onTitleClick} style={onTitleClick ? { cursor: 'pointer' } : undefined}>
        <h1 className="ellipsis">{title}</h1>{subtitle && <div className="sub ellipsis">{subtitle}</div>}
      </div>
      {right}
    </header>
  );
}
