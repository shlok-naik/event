const P: Record<string, string> = {
  back: 'M15 5l-7 7 7 7', plus: 'M12 5v14M5 12h14', send: 'M3 11l18-8-8 18-2-8-8-2z', map: 'M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  home: 'M4 11l8-7 8 7v9H5v-9z', bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4l2-2zM10 21h4', check: 'M5 12l5 5 9-10', users: 'M16 19v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3 3 0 100-6 3 3 0 000 6zM20 19v-1a3 3 0 00-2-2.8M16 5.2a3 3 0 010 5.6',
  pin: 'M12 21s7-6.2 7-11.5A7 7 0 005 9.5C5 14.8 12 21 12 21zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z', clock: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  close: 'M6 6l12 12M18 6L6 18', camera: 'M4 8h3l2-3h6l2 3h3v11H4V8zM12 17a4 4 0 100-8 4 4 0 000 8z', chevron: 'M9 5l7 7-7 7', logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0', calendar: 'M4 7h16v13H4V7zM4 11h16M8 4v4M16 4v4', tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4', mail: 'M3 6h18v12H3V6zM3 7l9 6 9-6', gift: 'M4 11h16v9H4v-9zM3 8h18v3H3V8zM12 8v12M12 8c-3 0-4-4-1-4s1 4 1 4zm0 0c3 0 4-4 1-4s-1 4-1 4z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  chat: 'M4 5h16v11H9l-5 4V5z', locate: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3', sync: 'M20 11a8 8 0 00-14-4M4 4v4h4M4 13a8 8 0 0014 4M20 20v-4h-4',
};
export function Icon({ name, size = 24, fill = false }: { name: keyof typeof P | string; size?: number; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? ''} />
    </svg>
  );
}
