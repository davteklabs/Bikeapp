// Place search via OpenStreetMap Nominatim.
// Policy: max 1 request/second, no autocomplete-per-keystroke hammering.
// https://operations.osmfoundation.org/policies/nominatim/

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

let lastRequest = 0;

export async function searchPlaces(query, { near, signal } = {}) {
  const wait = 1100 - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  lastRequest = Date.now();

  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '8', addressdetails: '0' });
  if (near) {
    // Prefer (but don't restrict to) results around the current view.
    const d = 0.5;
    params.set('viewbox', [near.lng - d, near.lat + d, near.lng + d, near.lat - d].join(','));
  }
  const res = await fetch(`${NOMINATIM_URL}/search?${params}`, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const json = await res.json();
  return json.map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    label: r.display_name,
    type: (r.type || '').replace(/_/g, ' '),
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
}

export async function reverseGeocode(p, { signal } = {}) {
  const params = new URLSearchParams({ lat: p.lat, lon: p.lng, format: 'jsonv2', zoom: '17' });
  try {
    const res = await fetch(`${NOMINATIM_URL}/reverse?${params}`, { signal });
    if (!res.ok) return null;
    const j = await res.json();
    return j.name || j.display_name?.split(',').slice(0, 2).join(',') || null;
  } catch {
    return null;
  }
}
