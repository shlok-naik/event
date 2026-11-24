const dtf = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, o);
const fmtTime = dtf({ hour: 'numeric', minute: '2-digit' });
const fmtDay = dtf({ weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = dtf({ weekday: 'long', day: 'numeric', month: 'long' });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayDiff = (a: Date, now = new Date()) => Math.round((startOfDay(a) - startOfDay(now)) / 86_400_000);

export const timeOf = (iso: string) => fmtTime.format(new Date(iso));

/** "Today", "Yesterday", "Mon 3 Mar" – for chat day separators */
export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso); const diff = dayDiff(d, now);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  return fmtLong.format(d);
}

/** Right-aligned stamp in chat lists: time today, "Yesterday", or short date */
export function listStamp(iso: string, now = new Date()) {
  const d = new Date(iso); const diff = dayDiff(d, now);
  if (diff === 0) return fmtTime.format(d);
  if (diff === -1) return 'Yesterday';
  return fmtDay.format(d);
}

/** "Tomorrow · 7:00 PM", "Sat 14 Dec · 7:00 PM" */
export function when(iso: string, now = new Date()) {
  const d = new Date(iso); const diff = dayDiff(d, now);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : fmtDay.format(d);
  return `${day} · ${fmtTime.format(d)}`;
}

/** "in 3 hours", "in 2 days", "starting now", "2 hours ago" */
export function relative(iso: string, nowMs = Date.now()) {
  const mins = Math.round((Date.parse(iso) - nowMs) / 60_000);
  const abs = Math.abs(mins);
  const unit = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  if (abs < 1) return 'now';
  return mins > 0 ? `in ${unit}` : `${unit} ago`;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

const PALETTE = ['#d6336c', '#7048e8', '#1c7ed6', '#0b7285', '#2b8a3e', '#e67700', '#c92a2a', '#5f3dc4'];
export const colorFor = (key: string) => {
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
};

/** Local datetime-local input value for a Date */
export const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
