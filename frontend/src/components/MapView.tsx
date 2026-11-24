import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface MapMarker { id: string; lat: number; lng: number; label: string }
const KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

let loader: Promise<any> | null = null;
function loadGoogle(): Promise<any> {
  if ((window as any).google?.maps) return Promise.resolve((window as any).google);
  loader ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY!)}&v=weekly`;
    s.async = true; s.onload = () => resolve((window as any).google); s.onerror = () => { loader = null; reject(new Error('Google Maps failed to load')); };
    document.head.appendChild(s);
  });
  return loader;
}

export const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

/** Interactive Google map when VITE_GOOGLE_MAPS_API_KEY is set; otherwise a lightweight fallback that still shows pins. */
export function MapView({ markers, height = 220, onSelect, label = 'Map' }: { markers: MapMarker[]; height?: number; onSelect?: (id: string) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(!KEY);
  useEffect(() => {
    if (!KEY || !ref.current) return;
    let cancelled = false;
    loadGoogle().then((g) => {
      if (cancelled || !ref.current) return;
      const map = new g.maps.Map(ref.current, { center: { lat: markers[0]?.lat ?? 51.5, lng: markers[0]?.lng ?? -0.12 }, zoom: 13, disableDefaultUI: true, zoomControl: true, gestureHandling: 'cooperative' });
      const bounds = new g.maps.LatLngBounds();
      for (const m of markers) {
        const mk = new g.maps.Marker({ position: { lat: m.lat, lng: m.lng }, map, title: m.label });
        if (onSelect) mk.addListener('click', () => onSelect(m.id));
        bounds.extend({ lat: m.lat, lng: m.lng });
      }
      if (markers.length > 1) map.fitBounds(bounds, 48);
    }).catch(() => setFailed(true));
    return () => { cancelled = true; };
  }, [markers, onSelect]);

  const pos = useMemo(() => {
    if (!markers.length) return [];
    const lats = markers.map((m) => m.lat), lngs = markers.map((m) => m.lng);
    const [la0, la1, ln0, ln1] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
    const norm = (v: number, a: number, b: number) => (b - a < 1e-6 ? 50 : 12 + ((v - a) / (b - a)) * 76);
    return markers.map((m) => ({ ...m, x: norm(m.lng, ln0, ln1), y: 100 - norm(m.lat, la0, la1) }));
  }, [markers]);

  if (!failed) return <div ref={ref} className="map" style={{ height }} role="region" aria-label={label} />;
  return (
    <div className="map" style={{ height, backgroundImage: 'linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)', backgroundSize: '32px 32px' }} role="region" aria-label={`${label} (simplified)`}>
      <div className="mapfb">
        {pos.map((m) => (
          <button key={m.id} className="pin" style={{ left: `${m.x}%`, top: `${m.y}%` }} onClick={() => onSelect?.(m.id)} aria-label={m.label} disabled={!onSelect}>
            <Icon name="pin" size={30} fill /><span className="ellipsis">{m.label}</span>
          </button>
        ))}
      </div>
      <span className="tiny muted" style={{ position: 'absolute', left: 8, bottom: 6, background: 'var(--surface)', padding: '1px 6px', borderRadius: 6 }}>Simplified map – add a Google Maps key for the live map</span>
    </div>
  );
}
