// Records a GPS track and exports it as GPX 1.1.

import { haversine } from './geo.js';

export class TrackRecorder {
  constructor() {
    this.points = [];
    this.distance = 0;
    this.elevationGain = 0;
    this.startedAt = null;
    this.movingTime = 0; // seconds
  }

  add(fix) {
    const pt = {
      lat: fix.lat,
      lng: fix.lng,
      ele: fix.altitude ?? null,
      time: fix.timestamp ?? Date.now(),
      accuracy: fix.accuracy ?? null,
    };
    if (pt.accuracy != null && pt.accuracy > 50) return false; // too noisy to trust
    const last = this.points[this.points.length - 1];
    if (!this.startedAt) this.startedAt = pt.time;
    if (last) {
      const d = haversine(last, pt);
      if (d < 3) return false; // ignore jitter while standing still
      const dt = (pt.time - last.time) / 1000;
      this.distance += d;
      if (dt > 0 && dt < 60 && d / dt > 0.5) this.movingTime += dt;
      if (pt.ele != null && last.ele != null && pt.ele - last.ele > 0) this.elevationGain += pt.ele - last.ele;
    }
    this.points.push(pt);
    return true;
  }

  get avgSpeed() {
    return this.movingTime > 0 ? this.distance / this.movingTime : 0;
  }

  toGPX(name = 'TrailNav activity', type = 'cycling') {
    const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const pts = this.points
      .map((p) =>
        `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">` +
        (p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '') +
        `<time>${new Date(p.time).toISOString()}</time></trkpt>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrailNav" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name>${this.startedAt ? `<time>${new Date(this.startedAt).toISOString()}</time>` : ''}</metadata>
  <trk>
    <name>${esc(name)}</name>
    <type>${esc(type)}</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  }
}
