import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

export const emailRe = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Enter many email addresses: type or paste (comma / space / newline separated). */
export function EmailChips({ value, onChange, id }: { value: string[]; onChange: (v: string[]) => void; id?: string }) {
  const [text, setText] = useState(''); const [bad, setBad] = useState<string | null>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const next = [...value]; let invalid: string | null = null;
    for (const p of parts) { if (!emailRe.test(p)) invalid = p; else if (!next.includes(p)) next.push(p); }
    onChange(next.slice(0, 50)); setBad(invalid ? `"${invalid}" is not a valid email` : null);
    setText(invalid ?? '');
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ' ', ';'].includes(e.key) && text.trim()) { e.preventDefault(); add(text); }
    else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
  };
  const paste = (e: ClipboardEvent<HTMLInputElement>) => { const t = e.clipboardData.getData('text'); if (/[\s,;]/.test(t.trim())) { e.preventDefault(); add(t); } };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <input id={id} className="input" type="email" inputMode="email" value={text} placeholder="name@example.com, another@example.com" aria-invalid={!!bad || undefined}
        onChange={(e) => setText(e.target.value)} onKeyDown={key} onBlur={() => text.trim() && add(text)} onPaste={paste} autoCapitalize="none" autoComplete="off" />
      {bad && <span className="err" role="alert">{bad}</span>}
      {value.length > 0 && (
        <div className="chips" aria-label="Invited emails">
          {value.map((v) => <span className="chip sel" key={v}>{v}<button type="button" aria-label={`Remove ${v}`} style={{ border: 0, background: 'none', color: 'inherit', display: 'grid' }} onClick={() => onChange(value.filter((x) => x !== v))}><Icon name="close" size={14} /></button></span>)}
        </div>
      )}
    </div>
  );
}
