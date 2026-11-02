// Trail difficulty ratings. A segment is only coloured when someone has actually
// rated it: either the defaults shipped in data/trail-ratings.json (maintained by
// the TrailNav developers) or the user's own rating on this device. Everything else
// is grey, because showing a hard trail as easy could get someone hurt.

export const RATINGS = {
  green: { label: 'Green', meaning: 'Easy', color: '#2e7d32' },
  blue: { label: 'Blue', meaning: 'Intermediate', color: '#1565c0' },
  black: { label: 'Black', meaning: 'Difficult', color: '#111111' },
};
export const UNRATED = { label: 'Not rated', meaning: 'No rating yet', color: '#6b7076' };

const valueOf = (v) => (typeof v === 'string' ? v : v?.rating);

/**
 * @param defaults  {id: 'green'|'blue'|'black' | {rating, name}} from the shipped file
 * @param mine      {id: {rating: 'green'|'blue'|'black'|'unrated', name}} set on this device
 * @returns {rating: key of RATINGS or null, source: 'you'|'default'|null}
 */
export function effectiveRating(id, defaults = {}, mine = {}) {
  const own = valueOf(mine[id]);
  if (own === 'unrated') return { rating: null, source: 'you' };
  if (RATINGS[own]) return { rating: own, source: 'you' };
  const def = valueOf(defaults[id]);
  if (RATINGS[def]) return { rating: def, source: 'default' };
  return { rating: null, source: null };
}

export const ratingColor = (rating) => (RATINGS[rating] || UNRATED).color;

/**
 * The shipped defaults with this device's ratings applied, in the same format as
 * data/trail-ratings.json, so an exported file can replace it directly.
 */
export function exportRatings(defaults = {}, mine = {}) {
  const ratings = {};
  for (const id of new Set([...Object.keys(defaults), ...Object.keys(mine)])) {
    const { rating } = effectiveRating(id, defaults, mine);
    if (!rating) continue;
    const name = mine[id]?.name ?? defaults[id]?.name ?? '';
    ratings[id] = name ? { rating, name } : { rating };
  }
  return {
    about: 'TrailNav default trail difficulty ratings. Keys are OpenStreetMap way IDs; rating is green, blue or black. Unlisted trails show grey (not rated).',
    exportedAt: new Date().toISOString(),
    ratings: Object.fromEntries(Object.entries(ratings).sort(([a], [b]) => Number(a) - Number(b))),
  };
}
