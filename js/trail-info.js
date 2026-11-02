// What we know about each trail segment beyond the map data: its difficulty rating
// and, where OpenStreetMap has none (or a wrong one), its name. Two sources:
// defaults shipped in data/trail-info.json (maintained by the TrailNav developers)
// and the user's own edits on this device, which take precedence.
//
// A segment is only coloured when someone has actually rated it. Everything else is
// grey, because showing a hard trail as easy could get someone hurt.

export const RATINGS = {
  green: { label: 'Green', meaning: 'Easy', color: '#2e7d32' },
  blue: { label: 'Blue', meaning: 'Intermediate', color: '#1565c0' },
  black: { label: 'Black', meaning: 'Difficult', color: '#111111' },
};
export const UNRATED = { label: 'Not rated', meaning: 'No rating yet', color: '#6b7076' };

const valueOf = (v) => (typeof v === 'string' ? v : v?.rating);

/**
 * @param defaults  {id: {rating, name}} from the shipped file (a bare rating string also works)
 * @param mine      {id: {rating: 'green'|'blue'|'black'|'unrated'}} set on this device
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
 * @param mapName   the name in the map data (OpenStreetMap, or its signed route)
 * @param myNames   {id: name} set on this device
 * @returns {name: string or null, source: 'you'|'default'|'map'|null}
 */
export function effectiveName(id, mapName, defaults = {}, myNames = {}) {
  if (myNames[id]) return { name: myNames[id], source: 'you' };
  if (defaults[id]?.name) return { name: defaults[id].name, source: 'default' };
  if (mapName) return { name: mapName, source: 'map' };
  return { name: null, source: null };
}

/**
 * The shipped defaults with this device's ratings and names applied, in the same
 * format as data/trail-info.json, so an exported file can replace it directly.
 */
export function exportTrailInfo(defaults = {}, myRatings = {}, myNames = {}) {
  const trails = {};
  for (const id of new Set([...Object.keys(defaults), ...Object.keys(myRatings), ...Object.keys(myNames)])) {
    const { rating } = effectiveRating(id, defaults, myRatings);
    const name = myNames[id] || defaults[id]?.name;
    if (!rating && !name) continue;
    trails[id] = { ...(rating && { rating }), ...(name && { name }) };
  }
  return {
    about: 'TrailNav trail knowledge base, shipped as defaults. Keys are OpenStreetMap way IDs. rating: green, blue or black, only when checked. name: the trail\'s name where OpenStreetMap has none or has it wrong. Unrated trails show grey.',
    exportedAt: new Date().toISOString(),
    trails: Object.fromEntries(Object.entries(trails).sort(([a], [b]) => Number(a) - Number(b))),
  };
}
