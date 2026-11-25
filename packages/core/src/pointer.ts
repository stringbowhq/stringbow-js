// Turns raw pointer samples into per-stroke summaries. The raw samples never leave
// this function: the browser SDK keeps them only until the stroke ends.
// Mirrored in model/stringbow_model/features.py (parity-tested).

import type { Stroke } from './window.ts';
import { mean, sd, median, round } from './stats.ts';

export interface Pt { t: number; x: number; y: number }

export const STROKE = {
  pauseMs: 120, // a gap longer than this ends the stroke
  maxMs: 4000, // force-split very long strokes
  minEvents: 4,
  minLenPx: 8,
};

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Count speed peaks in a 3-point smoothed speed profile. A new peak needs a real dip since the last one. */
export function speedPeaks(segV: number[]): number {
  const n = segV.length;
  if (!n) return 0;
  const sm: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i + 1);
    let s = 0;
    for (let k = lo; k <= hi; k++) s += segV[k];
    sm.push(s / (hi - lo + 1));
  }
  let vmax = 0;
  for (const v of sm) if (v > vmax) vmax = v;
  if (vmax <= 0) return 0;
  let peaks = 0;
  let lastPeak = 0;
  let valley = Infinity;
  for (let i = 0; i < n; i++) {
    const v = sm[i];
    if (v < valley) valley = v;
    const isMax = (i === 0 || v > sm[i - 1]) && (i === n - 1 || v >= sm[i + 1]);
    if (!isMax || v < 0.12 * vmax) continue;
    if (peaks === 0 || valley <= 0.6 * Math.min(lastPeak, v)) { peaks++; lastPeak = v; valley = v; }
    else if (v > lastPeak) { lastPeak = v; valley = v; }
  }
  return peaks;
}

export function summarizeStroke(pts: Pt[], end: number): Stroke | null {
  const n = pts.length;
  if (n < STROKE.minEvents) return null;
  const d = pts[n - 1].t - pts[0].t;
  const segLen: number[] = [];
  const segDt: number[] = [];
  const segV: number[] = [];
  let len = 0;
  for (let i = 0; i < n - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    const dt = Math.max(pts[i + 1].t - pts[i].t, 1);
    segLen.push(l);
    segDt.push(dt);
    segV.push((l / dt) * 1000);
    len += l;
  }
  if (len < STROKE.minLenPx) return null;
  const cx = pts[n - 1].x - pts[0].x;
  const cy = pts[n - 1].y - pts[0].y;
  const ch = Math.hypot(cx, cy);
  const dd = Math.max(d, 1);
  let vx = 0;
  let iPeak = 0;
  for (let i = 0; i < segV.length; i++) if (segV[i] > vx) { vx = segV[i]; iPeak = i; }
  const vMean = mean(segV);
  const tp = ((pts[iPeak].t + pts[iPeak + 1].t) / 2 - pts[0].t) / dd;

  const acc: number[] = [];
  for (let i = 0; i < segV.length - 1; i++) {
    acc.push(((segV[i + 1] - segV[i]) / ((segDt[i] + segDt[i + 1]) / 2)) * 1000);
  }

  // Turning angles between consecutive non-zero segments.
  const dirs: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    if (segLen[i] > 0) dirs.push(Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x));
  }
  const turns: number[] = [];
  for (let i = 0; i < dirs.length - 1; i++) turns.push(wrapAngle(dirs[i + 1] - dirs[i]));
  let flips = 0;
  let pairs = 0;
  let prevSign = 0;
  for (const t of turns) {
    if (Math.abs(t) <= 1e-6) continue;
    const s = t > 0 ? 1 : -1;
    if (prevSign !== 0) { pairs++; if (s !== prevSign) flips++; }
    prevSign = s;
  }

  // Max perpendicular deviation from the chord.
  let maxDev = 0;
  for (let i = 1; i < n - 1; i++) {
    const px = pts[i].x - pts[0].x;
    const py = pts[i].y - pts[0].y;
    const dist = ch >= 1 ? Math.abs(px * cy - py * cx) / ch : Math.hypot(px, py);
    if (dist > maxDev) maxDev = dist;
  }

  let d2 = 0;
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[i + 1].x - 2 * pts[i].x + pts[i - 1].x;
    const ay = pts[i + 1].y - 2 * pts[i].y + pts[i - 1].y;
    d2 += ax * ax + ay * ay;
  }
  const meanSeg = len / (n - 1);
  const jit = n > 2 ? Math.sqrt(d2 / (n - 2)) / Math.max(meanSeg, 0.5) : 0;

  let fracN = 0;
  for (const p of pts) {
    if (Math.abs(p.x - Math.round(p.x)) > 1e-6 || Math.abs(p.y - Math.round(p.y)) > 1e-6) fracN++;
  }
  const octant = Math.floor((((Math.atan2(cy, cx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4))) % 8;
  const dtMean = mean(segDt);

  return {
    d: round(d, 1),
    n,
    len: round(len, 1),
    ch: round(ch, 1),
    vm: round((len / dd) * 1000, 1),
    vx: round(vx, 1),
    vcv: round(vMean > 0 ? sd(segV) / vMean : 0, 4),
    tp: round(Math.min(1, Math.max(0, tp)), 4),
    v0: round(vx > 0 ? segV[0] / vx : 0, 4),
    v1: round(vx > 0 ? segV[segV.length - 1] / vx : 0, 4),
    acv: round(Math.min(1e5, acc.length ? sd(acc) / Math.max(vx, 1) : 0), 3),
    ang: round(turns.length ? mean(turns.map(Math.abs)) : 0, 5),
    flip: round(pairs ? flips / pairs : 0, 4),
    dev: round(Math.min(1000, maxDev / Math.max(ch, 1)), 5),
    jit: round(Math.min(1e4, jit), 4),
    pk: speedPeaks(segV),
    dtm: round(median(segDt), 2),
    dtcv: round(dtMean > 0 ? sd(segDt) / dtMean : 0, 4),
    frac: round(fracN / n, 3),
    dir: octant,
    end,
  };
}

/** Splits a stream of move events into strokes. Holds raw points only until a stroke closes. */
export class StrokeSegmenter {
  private pts: Pt[] = [];
  private out: Stroke[] = [];

  move(p: Pt): void {
    const last = this.pts[this.pts.length - 1];
    if (last && p.t - last.t > STROKE.pauseMs) this.close(0);
    if (this.pts.length && p.t - this.pts[0].t > STROKE.maxMs) this.close(2);
    this.pts.push(p);
  }

  /** Call on button press, pointer leaving the page, blur, or pause. */
  close(end: number): void {
    if (this.pts.length) {
      const s = summarizeStroke(this.pts, end);
      if (s) this.out.push(s);
      this.pts = [];
    }
  }

  /** Close the open stroke if it has gone quiet. */
  tick(now: number): void {
    const last = this.pts[this.pts.length - 1];
    if (last && now - last.t > STROKE.pauseMs) this.close(0);
  }

  take(): Stroke[] {
    const o = this.out;
    this.out = [];
    return o;
  }

  reset(): void {
    this.pts = [];
    this.out = [];
  }
}
