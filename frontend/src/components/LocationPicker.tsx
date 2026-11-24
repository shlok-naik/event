import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Location } from '../api';
import { useDebounced } from '../lib/hooks';
import { Icon } from './Icon';
import { Button, TextInput } from './ui';
import { MapView } from './MapView';

/** Search places (Google Places via the backend) or use the device location; shows the chosen spot on a map. */
export function LocationPicker({ value, onChange, id, placeholder = 'Search for a place' }: { value: Location | null; onChange: (l: Location | null) => void; id?: string; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const dq = useDebounced(q.trim(), 300);
  const res = useQuery({ queryKey: ['places', dq], queryFn: () => api.maps.search(dq), enabled: dq.length >= 2, staleTime: 60_000 });

  const useMine = () => {
    setGeoErr(null);
    if (!navigator.geolocation) return setGeoErr('Location is not available on this device');
    navigator.geolocation.getCurrentPosition(
      (p) => { onChange({ name: 'Current location', address: null, placeId: null, lat: p.coords.latitude, lng: p.coords.longitude }); setQ(''); },
      () => setGeoErr('Could not get your location – check permissions'), { timeout: 8000 },
    );
  };

  if (value) {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="row card" style={{ padding: 10 }}>
          <Icon name="pin" /><div className="grow"><div className="strong ellipsis">{value.name ?? 'Selected location'}</div>{value.address && <div className="small muted ellipsis">{value.address}</div>}</div>
          <Button type="button" variant="ghost" small onClick={() => onChange(null)}>Change</Button>
        </div>
        <MapView height={150} markers={[{ id: 'sel', lat: value.lat, lng: value.lng, label: value.name ?? 'Location' }]} label="Selected location" />
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <TextInput id={id} value={q} placeholder={placeholder} autoComplete="off" role="combobox" aria-expanded={open} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
        {open && dq.length >= 2 && (
          <div className="suggest" role="listbox">
            {res.isFetching && <div className="small muted" style={{ padding: 12 }}>Searching…</div>}
            {res.isError && <div className="small err" style={{ padding: 12 }}>{(res.error as Error).message || 'Place search is unavailable'}</div>}
            {res.data?.length === 0 && !res.isFetching && <div className="small muted" style={{ padding: 12 }}>No places found</div>}
            {res.data?.map((p) => (
              <button type="button" role="option" key={`${p.placeId}${p.lat}`} onClick={() => { onChange({ name: p.name, address: p.address, placeId: p.placeId, lat: p.lat, lng: p.lng }); setOpen(false); setQ(''); }}>
                <div className="strong">{p.name ?? p.address}</div>{p.name && <div className="small muted">{p.address}</div>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div><Button type="button" variant="ghost" small onClick={useMine}><Icon name="locate" size={18} /> Use my current location</Button>{geoErr && <span className="err small"> {geoErr}</span>}</div>
    </div>
  );
}
