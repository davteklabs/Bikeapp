// Minimal reader for OpenStreetMap .osm.pbf files (the format regional map extracts are
// published in): just enough to read nodes, ways and relations with their tags.
// Format: a sequence of [4-byte length][BlobHeader][Blob], each Blob a zlib-compressed
// protobuf PrimitiveBlock. https://wiki.openstreetmap.org/wiki/PBF_Format
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// ---- protobuf primitives (a cursor is {buf, pos}) ----

/** Unsigned varint as a Number (exact up to 2^53, which covers OSM ids and coordinates). */
export function varint(c) {
  const b = c.buf;
  let byte = b[c.pos++], v = byte & 0x7f;
  if (byte < 0x80) return v;
  byte = b[c.pos++]; v |= (byte & 0x7f) << 7; if (byte < 0x80) return v;
  byte = b[c.pos++]; v |= (byte & 0x7f) << 14; if (byte < 0x80) return v;
  byte = b[c.pos++]; v |= (byte & 0x7f) << 21; if (byte < 0x80) return v;
  let mul = 268435456; // 2^28
  do { byte = b[c.pos++]; v += (byte & 0x7f) * mul; mul *= 128; } while (byte >= 0x80);
  return v;
}

/** Signed (zigzag) varint. */
export const svarint = (c) => { const n = varint(c); return n % 2 ? -(n + 1) / 2 : n / 2; };

function skip(c, wire) {
  if (wire === 0) varint(c);
  else if (wire === 1) c.pos += 8;
  else if (wire === 2) { const n = varint(c); c.pos += n; }
  else if (wire === 5) c.pos += 4;
  else throw new Error(`unsupported protobuf wire type ${wire} at ${c.pos}`);
}

/** Calls fn(field, wire, cursor) for each field in buf[start, end). fn must consume the value. */
function fields(buf, start, end, fn) {
  const c = { buf, pos: start };
  while (c.pos < end) {
    const key = varint(c);
    const at = c.pos;
    fn(key >>> 3, key & 7, c);
    if (c.pos === at) skip(c, key & 7); // field not consumed
  }
}

const lenDelim = (c) => { const n = varint(c); const s = c.pos; c.pos += n; return [s, c.pos]; };

function packed(buf, [start, end], read) {
  const c = { buf, pos: start }, out = [];
  while (c.pos < end) out.push(read(c));
  return out;
}

// ---- file blocks ----

/**
 * Blocks in file order: {type, offset, size}. Read one's contents with readBlock().
 */
export function* blocks(fd) {
  const size = fstatSync(fd).size;
  const len = Buffer.alloc(4);
  let off = 0;
  while (off < size) {
    readSync(fd, len, 0, 4, off);
    const hlen = len.readUInt32BE(0);
    const h = Buffer.alloc(hlen);
    readSync(fd, h, 0, hlen, off + 4);
    let type = '', datasize = 0;
    fields(h, 0, hlen, (f, w, c) => {
      if (f === 1) { const [s, e] = lenDelim(c); type = h.toString('utf8', s, e); }
      else if (f === 3) datasize = varint(c);
    });
    off += 4 + hlen;
    yield { type, offset: off, size: datasize };
    off += datasize;
  }
}

/** A block's decompressed contents. */
export function readBlock(fd, { offset, size }) {
  const blob = Buffer.alloc(size);
  readSync(fd, blob, 0, size, offset);
  let raw = null, zlib = null;
  fields(blob, 0, size, (f, w, c) => {
    if (f === 1) { const [s, e] = lenDelim(c); raw = blob.subarray(s, e); }
    else if (f === 3) { const [s, e] = lenDelim(c); zlib = blob.subarray(s, e); }
    else if (f >= 4 && f <= 7) throw new Error(`unsupported block compression (field ${f}); only zlib is supported`);
  });
  return raw || inflateSync(zlib);
}

/** The OSMHeader block: {features, timestamp} (timestamp = data date, ISO, if present). */
export function parseHeader(buf) {
  const out = { features: [], timestamp: null };
  fields(buf, 0, buf.length, (f, w, c) => {
    if (f === 4 || f === 5) { const [s, e] = lenDelim(c); out.features.push(buf.toString('utf8', s, e)); }
    else if (f === 32) out.timestamp = new Date(varint(c) * 1000).toISOString();
  });
  return out;
}

/**
 * An OSMData block. Returns {nodes, ways, relations} flags for what it holds, and lets
 * the caller walk only the element types it wants:
 *   eachNode((id, lat, lon) => ...)          lat/lon in 1e-7 degrees (integers)
 *   eachWay((id, tags, refs) => ...)          tags: {k: v}, refs: node ids
 *   eachRelation((id, tags, members) => ...)  members: [{type: 'node'|'way'|'relation', ref, role}]
 */
export function parseData(buf) {
  let strTable = null, gran = 100, latOff = 0, lonOff = 0;
  const groups = [];
  fields(buf, 0, buf.length, (f, w, c) => {
    if (f === 1) strTable = lenDelim(c);
    else if (f === 2) groups.push(lenDelim(c));
    else if (f === 17) gran = varint(c);
    else if (f === 19) latOff = varint(c);
    else if (f === 20) lonOff = varint(c);
  });
  if (latOff || lonOff || gran % 100) throw new Error(`unsupported coordinate encoding (granularity ${gran}, offsets ${latOff}/${lonOff})`);
  const scale = gran / 100; // to 1e-7 degrees

  // String table, decoded only on use (node blocks never need it).
  const strRanges = [];
  if (strTable) fields(buf, strTable[0], strTable[1], (f, w, c) => { if (f === 1) strRanges.push(lenDelim(c)); });
  const cache = [];
  const str = (i) => cache[i] ?? (cache[i] = buf.toString('utf8', strRanges[i][0], strRanges[i][1]));
  const tagsOf = (keys, vals) => { const t = {}; for (let i = 0; i < keys.length; i++) t[str(keys[i])] = str(vals[i]); return t; };

  // What each group holds: 1 nodes, 2 dense nodes, 3 ways, 4 relations.
  const kinds = groups.map(([s, e]) => { let k = 0; fields(buf, s, e, (f, w, c) => { if (!k) k = f; lenDelim(c); }); return k; });

  return {
    nodes: kinds.some((k) => k === 1 || k === 2),
    ways: kinds.includes(3),
    relations: kinds.includes(4),
    eachNode(fn) {
      groups.forEach(([s, e], g) => {
        if (kinds[g] === 2) {
          fields(buf, s, e, (f, w, c) => {
            if (f !== 2) return;
            const [ds, de] = lenDelim(c);
            let ids = null, lats = null, lons = null;
            fields(buf, ds, de, (f2, w2, c2) => {
              if (f2 === 1) ids = lenDelim(c2); else if (f2 === 8) lats = lenDelim(c2); else if (f2 === 9) lons = lenDelim(c2);
            });
            if (!ids) return;
            const ci = { buf, pos: ids[0] }, ca = { buf, pos: lats[0] }, co = { buf, pos: lons[0] };
            let id = 0, lat = 0, lon = 0;
            while (ci.pos < ids[1]) {
              id += svarint(ci); lat += svarint(ca); lon += svarint(co);
              fn(id, lat * scale, lon * scale);
            }
          });
        } else if (kinds[g] === 1) {
          fields(buf, s, e, (f, w, c) => {
            if (f !== 1) return;
            const [ns, ne] = lenDelim(c);
            let id = 0, lat = 0, lon = 0;
            fields(buf, ns, ne, (f2, w2, c2) => {
              if (f2 === 1) id = svarint(c2); else if (f2 === 8) lat = svarint(c2); else if (f2 === 9) lon = svarint(c2);
            });
            fn(id, lat * scale, lon * scale);
          });
        }
      });
    },
    eachWay(fn) {
      groups.forEach(([s, e], g) => {
        if (kinds[g] !== 3) return;
        fields(buf, s, e, (f, w, c) => {
          if (f !== 3) return;
          const [ws, we] = lenDelim(c);
          let id = 0, keys = [], vals = [], refs = [];
          fields(buf, ws, we, (f2, w2, c2) => {
            if (f2 === 1) id = varint(c2);
            else if (f2 === 2) keys = packed(buf, lenDelim(c2), varint);
            else if (f2 === 3) vals = packed(buf, lenDelim(c2), varint);
            else if (f2 === 8) { let r = 0; refs = packed(buf, lenDelim(c2), (cc) => (r += svarint(cc))); }
          });
          fn(id, tagsOf(keys, vals), refs);
        });
      });
    },
    eachRelation(fn) {
      groups.forEach(([s, e], g) => {
        if (kinds[g] !== 4) return;
        fields(buf, s, e, (f, w, c) => {
          if (f !== 4) return;
          const [rs, re] = lenDelim(c);
          let id = 0, keys = [], vals = [], roles = [], mem = [], types = [];
          fields(buf, rs, re, (f2, w2, c2) => {
            if (f2 === 1) id = varint(c2);
            else if (f2 === 2) keys = packed(buf, lenDelim(c2), varint);
            else if (f2 === 3) vals = packed(buf, lenDelim(c2), varint);
            else if (f2 === 8) roles = packed(buf, lenDelim(c2), varint);
            else if (f2 === 9) { let m = 0; mem = packed(buf, lenDelim(c2), (cc) => (m += svarint(cc))); }
            else if (f2 === 10) types = packed(buf, lenDelim(c2), varint);
          });
          fn(id, tagsOf(keys, vals), mem.map((ref, i) => ({ type: ['node', 'way', 'relation'][types[i]], ref, role: str(roles[i]) })));
        });
      });
    },
  };
}

/** Open a .osm.pbf file; call close() when done. */
export function openPbf(path) {
  const fd = openSync(path, 'r');
  return { fd, blocks: () => blocks(fd), read: (b) => readBlock(fd, b), close: () => closeSync(fd) };
}
