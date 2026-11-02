// Unit formatting. `units` is 'metric' or 'imperial'.

export function formatDistance(m, units = 'metric') {
  if (m == null || !isFinite(m)) return '–';
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.round(ft / 10) * 10} ft`;
    const mi = m / 1609.344;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${m < 100 ? Math.round(m / 5) * 5 : Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Distance phrased for speech ("300 metres", "half a mile"). */
export function spokenDistance(m, units = 'metric') {
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.round(ft / 50) * 50 || 50} feet`;
    const mi = m / 1609.344;
    if (mi < 0.35) return 'a quarter mile';
    if (mi < 0.75) return 'half a mile';
    return `${mi.toFixed(1).replace(/\.0$/, '')} miles`;
  }
  if (m < 100) return `${Math.max(10, Math.round(m / 10) * 10)} metres`;
  if (m < 1000) return `${Math.round(m / 50) * 50} metres`;
  return `${(m / 1000).toFixed(1).replace(/\.0$/, '')} kilometres`;
}

export function formatDuration(s) {
  if (s == null || !isFinite(s)) return '–';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${String(mins % 60).padStart(2, '0')} min`;
}

export function formatSpeed(mps, units = 'metric') {
  if (mps == null || !isFinite(mps) || mps < 0) return '–';
  return units === 'imperial'
    ? `${(mps * 2.23694).toFixed(1)} mph`
    : `${(mps * 3.6).toFixed(1)} km/h`;
}

export function formatClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP]M)$/i, (_, p) => p.toLowerCase());
}
