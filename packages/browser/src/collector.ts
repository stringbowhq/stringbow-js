// Turns DOM input events into evidence windows.
//
// What never leaves this file: which key was pressed, what was typed, where the
// pointer was, what was clicked, the page URL or any page content. Key identity is
// used only to pair a press with its release and (optionally) to pick one of six
// coarse classes; pointer coordinates are used only to compute a stroke summary and
// are dropped when the stroke ends. The same holds for finger positions on a touch
// screen. Device motion is reduced to a handful of averages per window.

import {
  KEY_CLASS, StrokeSegmenter, WINDOW_VERSION, summarizeStroke,
  type Click, type EvidenceWindow, type FocusBlock, type KeyBlock, type MotionBlock, type Pt, type ScrollBurst, type Stroke, type Swipe, type Tap,
} from '@stringbow/core/sdk';

export type KeyDetail = 'timing' | 'coarse';

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS|CapsLock|Tab|Escape|Arrow|Page|Home|End|Insert|F\d|NumLock|ScrollLock|Pause|ContextMenu|PrintScreen|Fn|Audio|Media|Browser|Launch|Lang|Convert|NonConvert|Kana|Power|Sleep|Wake|Help|Eject)/;

/** Coarse class from the physical key. -1 = not part of the timed sequence. */
export function classify(code: string, key: string): number {
  if (!code && !key) return -1;
  if (/^Key[A-Z]$/.test(code)) return KEY_CLASS.letter;
  if (/^(Digit|Numpad)\d$/.test(code)) return KEY_CLASS.digit;
  if (code === 'Space' || key === ' ') return KEY_CLASS.space;
  if (code === 'Backspace' || code === 'Delete') return KEY_CLASS.erase;
  if (code === 'Enter' || code === 'NumpadEnter') return KEY_CLASS.enter;
  if (MODIFIER_CODES.test(code)) return -1;
  if (key.length === 1) return /\p{L}/u.test(key) ? KEY_CLASS.letter : /\d/.test(key) ? KEY_CLASS.digit : KEY_CLASS.punct;
  if (/^(Minus|Equal|Bracket|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|Intl|Numpad(Add|Subtract|Multiply|Divide|Decimal|Comma))/.test(code)) return KEY_CLASS.punct;
  return -1;
}

const LEFT_HAND = /^(Key[QWERTASDFGZXCVB]|Digit[1-5]|Backquote)$/;
const RIGHT_HAND = /^(Key[YUIOPHJKLNM]|Digit[6-9]|Digit0|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|Backspace|Enter)$/;

/** Which hand a physical key belongs to on a standard layout: 0 left, 1 right, -1 either or unknown (space, numpad). */
export function handOf(code: string): number {
  return LEFT_HAND.test(code) ? 0 : RIGHT_HAND.test(code) ? 1 : -1;
}

/** Fields the collector must not observe at all. */
export function isSensitiveTarget(t: EventTarget | null): boolean {
  const el = t as (Element & { type?: string; autocomplete?: string }) | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('[data-stringbow-skip]')) return true;
  if (el.tagName === 'INPUT' && (el.type === 'password' || /^(cc-|one-time-code|current-password|new-password)/.test(el.autocomplete ?? ''))) return true;
  return false;
}

interface PendingKey { id: string; down: number; up: number | null; cls: number; dd: number; hand: number; prevHand: number }

export interface TouchPoint { id: number; x: number; y: number; rx?: number; ry?: number; force?: number }
export interface TouchLike { timeStamp: number; isTrusted?: boolean; changed: TouchPoint[]; active: number }
export interface MotionSample {
  timeStamp: number;
  /** Acceleration without gravity (m/s^2); null when the device does not separate it. */
  ax: number | null; ay: number | null; az: number | null;
  /** Acceleration including gravity. */
  gx: number | null; gy: number | null; gz: number | null;
  /** Rotation rate, deg/s. */
  rx: number | null; ry: number | null; rz: number | null;
}

const TAP_MAX_SLOP_PX = 10;
const TAP_MAX_MS = 700;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const STUCK_MS = 5000;
const MAX_GAP = 5000;
const BUCKET = 250;
/** A pause longer than this ends a scroll gesture. */
const SCROLL_GAP_MS = 300;
/** Wheel deltas reported in lines or pages are turned into pixels with these sizes. */
const LINE_PX = 16;
const PAGE_PX = 800;

/** Summary of one scroll gesture. Events are {t, |delta| in px}, in order. Null when it is too short to say anything. */
export function summarizeScroll(ev: { t: number; d: number }[]): ScrollBurst | null {
  if (ev.length < 3) return null;
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const gaps: number[] = [];
  for (let i = 1; i < ev.length; i++) gaps.push(ev[i].t - ev[i - 1].t);
  const gm = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const gsd = Math.sqrt(gaps.reduce((a, b) => a + (b - gm) ** 2, 0) / gaps.length);
  const ds = ev.map((e) => e.d);
  const peak = Math.max(...ds);
  const last = ds.slice(-Math.max(1, Math.floor(ds.length / 3)));
  return {
    d: r1(Math.min(30000, ev[ev.length - 1].t - ev[0].t)),
    n: Math.min(5000, ev.length),
    dist: r1(Math.min(1e7, ds.reduce((a, b) => a + b, 0))),
    step: r1(Math.min(1e5, med(ds))),
    dtm: r1(Math.min(5000, med(gaps))),
    dtcv: r3(Math.min(100, gm > 0 ? gsd / gm : 0)),
    tail: r3(peak > 0 ? Math.min(1, last.reduce((a, b) => a + b, 0) / last.length / peak) : 0),
  };
}

export class Collector {
  private keyDetail: KeyDetail;
  private pending: PendingKey[] = [];
  private lastDown = -1;
  private lastKeyAt = -1e9;
  /** Last press of a key that can put text in a field. Tab, arrows and other navigation keys do not count. */
  private lastTextKeyAt = -1e9;
  private kb = { downs: 0, untyped: 0, pasted: 0, repeats: 0, other: 0 };
  private hold: number[] = [];
  private dd: number[] = [];
  private cls: number[] = [];
  private lastHand = -1;
  private hands = { gs: [] as number[], gx: [] as number[], hl: [] as number[], hr: [] as number[] };

  // Touch screen
  private coarse: boolean;
  private finger: { id: number; pts: Pt[]; ar: number; pr: number; n: number; multi: boolean } | null = null;
  private touchMoves = 0;
  private swipes: Swipe[] = [];
  private taps: Tap[] = [];
  private multi = 0;
  private lastLift = -1;
  private lastSoftKey = -1;
  private softGaps: number[] = [];
  private fingerDowns: number[] = [];

  // Focus
  private focus: FocusBlock = { n: 0, key: 0, ptr: 0, auto: 0, dw: [], ret: [] };
  private fieldSince: number | null = null;
  private lastPressAt = -1e9;
  private returnedAt: number | null = null;

  // Device motion
  private motion: { t: number; a: number; r: number; gx: number; gy: number; gz: number }[] = [];

  private seg = new StrokeSegmenter();
  private moves = 0;
  private trail: { t: number; x: number; y: number; move: boolean }[] = [];
  private clicks: Click[] = [];
  private downAt: number | null = null;
  private pendingClick: Omit<Click, 'dw'> | null = null;
  private pointerType = 0;

  private wheel: { t: number; d: number }[] = [];
  /** The scroll gesture in progress. It may span a window boundary; it is summarised once it ends. */
  private gesture: { t: number; d: number }[] = [];
  private scrollBursts: ScrollBurst[] = [];
  private scrollNoInput = 0;
  private lastInputAt = -1e9;

  private buckets = new Set<number>();
  private visibleMs = 0;
  private visSince: number | null = null;
  private blurs = 0;
  private windowStart: number;
  private paused = false;

  constructor(opts: { keyDetail: KeyDetail; now: number; visible: boolean; coarsePointer?: boolean }) {
    this.keyDetail = opts.keyDetail;
    this.coarse = !!opts.coarsePointer;
    this.windowStart = opts.now;
    if (opts.visible) this.visSince = opts.now;
  }

  setPaused(p: boolean, now: number): void {
    this.paused = p;
    if (p) {
      // Dropping, not buffering: nothing typed or moved while paused is ever summarised.
      this.pending = [];
      this.hold = []; this.dd = []; this.cls = [];
      this.seg.reset();
      this.trail = []; this.clicks = []; this.wheel = []; this.gesture = []; this.scrollBursts = [];
      this.pendingClick = null; this.downAt = null;
      this.lastDown = -1;
      this.lastHand = -1;
      this.hands = { gs: [], gx: [], hl: [], hr: [] };
      this.finger = null; this.swipes = []; this.taps = []; this.softGaps = []; this.fingerDowns = [];
      this.touchMoves = 0; this.multi = 0; this.lastLift = -1; this.lastSoftKey = -1;
      this.focus = { n: 0, key: 0, ptr: 0, auto: 0, dw: [], ret: [] };
      this.fieldSince = null; this.returnedAt = null;
      this.motion = [];
      this.buckets.clear();
    } else {
      this.windowStart = now;
      this.visibleMs = 0;
      if (this.visSince !== null) this.visSince = now;
    }
  }

  /** Any input at time t: counts as activity, and answers "how long after coming back did the person act". */
  private touch(t: number): void {
    this.buckets.add(Math.floor(t / BUCKET));
    this.lastInputAt = t;
    if (this.returnedAt !== null) {
      if (this.focus.ret.length < 30) this.focus.ret.push(Math.min(60000, Math.max(0, Math.round(t - this.returnedAt))));
      this.returnedAt = null;
    }
  }

  // ---------- keyboard ----------
  keydown(e: { code: string; key: string; repeat: boolean; timeStamp: number; target: EventTarget | null; isTrusted?: boolean }): void {
    if (this.paused || e.isTrusted === false || isSensitiveTarget(e.target)) return;
    const t = e.timeStamp;
    this.touch(t);
    this.lastKeyAt = t;
    // Keys that can produce text: printable characters, and what IMEs and on-screen keyboards report.
    if (e.key.length === 1 || e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead') this.lastTextKeyAt = t;
    if (e.repeat) { this.kb.repeats++; return; }
    if (this.coarse) {
      // On-screen keyboard: the browser reports no usable hold time and often no key at all.
      // Only the rhythm of presses is kept.
      if (this.lastSoftKey >= 0 && this.softGaps.length < 220) this.softGaps.push(Math.min(MAX_GAP, Math.max(0, Math.round(t - this.lastSoftKey))));
      this.lastSoftKey = t;
      return;
    }
    const c = classify(e.code, e.key);
    if (c < 0) { this.kb.other++; return; }
    this.kb.downs++;
    const gap = this.lastDown < 0 ? -1 : Math.min(MAX_GAP, Math.max(0, Math.round(t - this.lastDown)));
    this.lastDown = t;
    const hand = handOf(e.code);
    this.pending.push({ id: e.code || e.key, down: t, up: null, cls: c, dd: gap, hand, prevHand: this.lastHand });
    this.lastHand = hand;
  }

  keyup(e: { code: string; key: string; timeStamp: number; target: EventTarget | null }): void {
    if (this.paused) return;
    const id = e.code || e.key;
    const k = this.pending.find((p) => p.id === id && p.up === null);
    if (k) k.up = e.timeStamp;
    this.drainKeys(e.timeStamp);
  }

  /** Move completed keys out in press order; a key still held blocks the ones pressed after it. */
  private drainKeys(now: number): void {
    while (this.pending.length) {
      const k = this.pending[0];
      if (k.up === null) {
        if (now - k.down > STUCK_MS) { this.pending.shift(); continue; }
        break;
      }
      this.pending.shift();
      const hold = Math.min(5000, Math.max(0, Math.round(k.up - k.down)));
      this.hold.push(hold);
      this.dd.push(k.dd);
      this.cls.push(k.cls);
      if (this.keyDetail === 'coarse') {
        if (k.hand === 0) this.hands.hl.push(hold);
        if (k.hand === 1) this.hands.hr.push(hold);
        if (k.hand >= 0 && k.prevHand >= 0 && k.dd > 0 && k.dd <= 1500) (k.hand === k.prevHand ? this.hands.gs : this.hands.gx).push(k.dd);
      }
    }
  }

  input(e: { inputType?: string; timeStamp: number; target: EventTarget | null; isTrusted?: boolean }): void {
    if (this.paused || isSensitiveTarget(e.target)) return;
    const type = e.inputType ?? '';
    if (type === 'insertFromPaste' || type === 'insertFromDrop' || type === 'insertFromYank') { this.kb.pasted++; this.touch(e.timeStamp); return; }
    if (type.startsWith('delete') || type.startsWith('history') || type.startsWith('format')) return;
    if (type === 'insertLineBreak' || type === 'insertParagraph') return; // Enter in a text area
    // Text arrived with no text key pressed just before it: autofill, a script setting the value, dictation. A Tab
    // or Enter just before does not vouch for it (a page-element agent tabs to a field, then fills it).
    if (e.timeStamp - this.lastTextKeyAt > 150 || e.isTrusted === false) this.kb.untyped++;
  }

  // ---------- pointer ----------
  private ptCode(type: string): number { return type === 'touch' ? 1 : type === 'pen' ? 2 : 0; }

  pointermove(e: { clientX: number; clientY: number; timeStamp: number; pointerType: string; isTrusted?: boolean }): void {
    if (this.paused || e.isTrusted === false) return;
    const t = e.timeStamp;
    this.pointerType = Math.max(this.pointerType, this.ptCode(e.pointerType));
    if (e.pointerType !== 'mouse' && e.pointerType !== '') return;
    this.touch(t);
    this.moves++;
    const p = { t, x: e.clientX, y: e.clientY };
    this.seg.move(p);
    this.remember(p, true);
  }

  /** Short memory of where the pointer has been on this page (moves and presses). Cleared when it leaves. */
  private remember(p: { t: number; x: number; y: number }, move: boolean): void {
    this.trail.push({ ...p, move });
    if (this.trail.length > 96) this.trail.shift();
  }

  pointerdown(e: { clientX: number; clientY: number; timeStamp: number; pointerType: string; button: number; isTrusted?: boolean }, focused: boolean): void {
    if (this.paused || e.isTrusted === false) return;
    const t = e.timeStamp;
    this.touch(t);
    this.lastPressAt = t;
    this.pointerType = Math.max(this.pointerType, this.ptCode(e.pointerType));
    if (e.pointerType !== 'mouse' && e.pointerType !== '') return;
    this.seg.close(1);
    const trail = this.trail;
    // Reference point: the newest known position that is an earlier press or at least half a second old.
    // The approach is whatever movement happened on the way from there to this press.
    let ri = trail.length ? 0 : -1;
    for (let i = trail.length - 1; i >= 0; i--) if (!trail[i].move || t - trail[i].t >= 500) { ri = i; break; }
    const ref = ri >= 0 ? trail[ri] : null;
    const last = trail.length ? trail[trail.length - 1] : null;
    let appr = 0;
    for (let i = ri + 1; i < trail.length; i++) if (trail[i].move) appr++;
    const trav = ref ? Math.hypot(e.clientX - ref.x, e.clientY - ref.y) : 0;
    // "Settled": the page has focus and the pointer has been on this page for a moment. Right after it
    // arrives (or the page regains focus) a press may legitimately land anywhere.
    // An earlier press on this page also proves the pointer was already here.
    const settled = focused && ref !== null && (t - trail[0].t >= 300 || trail.some((m) => !m.move));
    this.pendingClick = { pre: last ? Math.max(0, Math.round(t - last.t)) : 0, appr, trav: Math.round(trav * 10) / 10, ok: settled ? 1 : 0 };
    this.downAt = t;
    this.remember({ t, x: e.clientX, y: e.clientY }, false);
  }

  pointerup(e: { timeStamp: number; pointerType: string }): void {
    if (this.paused || this.downAt === null || !this.pendingClick) return;
    this.clicks.push({ dw: Math.min(30000, Math.max(0, Math.round((e.timeStamp - this.downAt) * 10) / 10)), ...this.pendingClick });
    this.downAt = null;
    this.pendingClick = null;
  }

  /** The pointer left the page or the page lost focus: whatever comes next may legitimately start somewhere else. */
  pointerGone(): void {
    this.seg.close(2);
    this.trail = [];
  }

  // ---------- touch screen ----------
  touchStart(e: TouchLike): void {
    if (this.paused || e.isTrusted === false || !e.changed.length) return;
    const t = e.timeStamp;
    this.touch(t);
    this.lastPressAt = t;
    this.pointerType = Math.max(this.pointerType, 1);
    if (this.fingerDowns.length < 200) this.fingerDowns.push(t);
    if (this.finger) { this.finger.multi = true; return; }
    const c = e.changed[0];
    this.finger = { id: c.id, pts: [{ t, x: c.x, y: c.y }], ar: 0, pr: 0, n: 0, multi: e.active > 1 };
    this.contact(c);
  }

  private contact(c: TouchPoint): void {
    const f = this.finger!;
    f.ar += ((c.rx ?? 0) + (c.ry ?? 0)) / 2;
    f.pr += c.force ?? 0;
    f.n++;
  }

  touchMove(e: TouchLike): void {
    if (this.paused || e.isTrusted === false || !this.finger) return;
    this.touch(e.timeStamp);
    this.touchMoves++;
    if (e.active > 1) this.finger.multi = true;
    const c = e.changed.find((x) => x.id === this.finger!.id);
    if (!c || this.finger.pts.length >= 600) return;
    this.finger.pts.push({ t: e.timeStamp, x: c.x, y: c.y });
    this.contact(c);
  }

  touchEnd(e: TouchLike, cancelled = false): void {
    const f = this.finger;
    if (this.paused || !f) return;
    if (!e.changed.some((x) => x.id === f.id)) { if (e.active === 0) this.finger = null; return; }
    const t = e.timeStamp;
    this.finger = null;
    const gap = this.lastLift < 0 ? -1 : Math.min(MAX_GAP, Math.max(0, Math.round(t - this.lastLift)));
    this.lastLift = t;
    if (f.multi) { this.multi++; return; }
    const pts = f.pts;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const dur = t - pts[0].t;
    const ar = r1(Math.min(500, f.ar / f.n));
    const pr = r3(Math.min(1, Math.max(0, f.pr / f.n)));
    if (len <= TAP_MAX_SLOP_PX && dur <= TAP_MAX_MS) {
      if (!cancelled && this.taps.length < 80) this.taps.push({ dw: r1(Math.max(0, dur)), slop: r1(len), ar, pr, gap });
      return;
    }
    // The summary is all that is kept; the finger positions go no further than this line.
    const s = summarizeStroke(pts, cancelled ? 2 : 0);
    if (s && this.swipes.length < 40) this.swipes.push({ ...s, ar, pr });
  }

  // ---------- focus between fields ----------
  focusIn(e: { timeStamp: number; target: EventTarget | null }): void {
    if (this.paused) return;
    const t = e.timeStamp;
    this.closeField(t);
    // Password and payment fields are not observed, not even as "a field got focus".
    if (isSensitiveTarget(e.target)) return;
    const f = this.focus;
    f.n++;
    if (t - this.lastKeyAt <= 300) f.key++;
    else if (t - this.lastPressAt <= 700) f.ptr++;
    else f.auto++;
    this.fieldSince = t;
  }

  focusOut(e: { timeStamp: number }): void {
    if (!this.paused) this.closeField(e.timeStamp);
  }

  private closeField(t: number): void {
    if (this.fieldSince === null) return;
    if (this.focus.dw.length < 30) this.focus.dw.push(Math.min(60000, Math.max(0, Math.round(t - this.fieldSince))));
    this.fieldSince = null;
  }

  // ---------- device motion (only after the page calls enableMotion) ----------
  motionSample(e: MotionSample): void {
    if (this.paused || this.motion.length >= 2000) return;
    const has = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);
    const g = has(e.gx) && has(e.gy) && has(e.gz);
    const lin = has(e.ax) && has(e.ay) && has(e.az);
    if (!g && !lin) return;
    // Movement with gravity removed: how far the size of the reading is from standing gravity. This is the form the
    // constants were calibrated on (the public dataset has no gravity-free reading), so it is preferred when available.
    const a = g ? Math.abs(Math.hypot(e.gx!, e.gy!, e.gz!) - 9.81) : Math.hypot(e.ax!, e.ay!, e.az!);
    const r = has(e.rx) && has(e.ry) && has(e.rz) ? Math.hypot(e.rx, e.ry, e.rz) : 0;
    this.motion.push({ t: e.timeStamp, a, r, gx: g ? e.gx! : 0, gy: g ? e.gy! : 0, gz: g ? e.gz! : 0 });
  }

  private motionBlock(dur: number): MotionBlock | null {
    const m = this.motion;
    this.motion = [];
    const downs = this.fingerDowns;
    this.fingerDowns = [];
    if (m.length < 2) return null;
    const mean = (f: (x: (typeof m)[number]) => number) => m.reduce((s, x) => s + f(x), 0) / m.length;
    const sdOf = (f: (x: (typeof m)[number]) => number, mu: number) => Math.sqrt(m.reduce((s, x) => s + (f(x) - mu) ** 2, 0) / m.length);
    const am = mean((x) => x.a);
    const rm = mean((x) => x.r);
    // Tilt comes from the average direction of gravity, not the average of angles: a phone lying flat sits
    // right where the angle jumps from +180 to -180, and averaging those would give nonsense.
    const deg = 180 / Math.PI;
    const mx = mean((x) => x.gx), my = mean((x) => x.gy), mz = mean((x) => x.gz);
    const tb = Math.atan2(my, mz) * deg;
    const tg = Math.atan2(-mx, Math.hypot(my, mz)) * deg;
    const off = (x: (typeof m)[number]) => { let d = Math.atan2(x.gy, x.gz) * deg - tb; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
    const tsd = Math.sqrt(m.reduce((s2, x) => s2 + off(x) ** 2, 0) / m.length);
    let near = 0;
    let nearN = 0;
    for (const x of m) if (downs.some((d) => x.t >= d && x.t - d <= 150)) { near += x.a; nearN++; }
    return {
      n: Math.min(5000, m.length),
      hz: r1(Math.min(1000, m.length / (dur / 1000))),
      am: r3(Math.min(500, am)), asd: r3(Math.min(500, sdOf((x) => x.a, am))),
      rm: r3(Math.min(5000, rm)), rsd: r3(Math.min(5000, sdOf((x) => x.r, rm))),
      tb: r1(Math.max(-180, Math.min(180, tb))), tg: r1(Math.max(-90, Math.min(90, tg))),
      tsd: r3(Math.min(180, tsd)),
      tc: nearN && am > 1e-6 ? r3(Math.min(50, near / nearN / am)) : 0,
    };
  }

  // ---------- scroll ----------
  wheelEvent(e: { deltaY: number; deltaX: number; timeStamp: number; deltaMode?: number; isTrusted?: boolean }): void {
    if (this.paused) return;
    this.touch(e.timeStamp);
    this.wheel.push({ t: e.timeStamp, d: Math.round(Math.abs(e.deltaY) + Math.abs(e.deltaX)) });
    // Gestures are summarised from real input only, in pixels whatever unit the browser reports in.
    if (e.isTrusted === false) return;
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
    const g = this.gesture;
    if (g.length && e.timeStamp - g[g.length - 1].t > SCROLL_GAP_MS) this.endGesture();
    this.gesture.push({ t: e.timeStamp, d: (Math.abs(e.deltaY) + Math.abs(e.deltaX)) * unit });
    if (this.gesture.length >= 600) this.endGesture();
  }

  private endGesture(): void {
    const s = summarizeScroll(this.gesture);
    this.gesture = [];
    if (s && this.scrollBursts.length < 40) this.scrollBursts.push(s);
  }

  scrollEvent(e: { timeStamp: number }): void {
    if (this.paused) return;
    if (e.timeStamp - this.lastInputAt > 400) this.scrollNoInput++;
  }

  // ---------- focus ----------
  visibility(visible: boolean, now: number): void {
    if (visible && this.visSince === null) { this.visSince = now; this.returnedAt = now; }
    if (!visible && this.visSince !== null) {
      this.visibleMs += now - this.visSince;
      this.visSince = null;
      this.blurs++;
      this.pointerGone();
      this.closeField(now);
      this.finger = null;
    }
  }

  // ---------- window ----------
  /** Close the current window. Returns null when it holds no input worth sending. */
  take(now: number, timeOrigin: number, webdriver: boolean, zoomed: boolean): Omit<EvidenceWindow, 'sid' | 'seq' | 'prev'> | null {
    const start = this.windowStart;
    const dur = Math.max(1, now - start);
    this.windowStart = now;
    if (this.paused) return null;
    this.drainKeys(now);
    this.seg.tick(now);
    const strokes: Stroke[] = this.seg.take();
    let vis = this.visibleMs;
    if (this.visSince !== null) { vis += now - Math.max(this.visSince, start); this.visSince = now; }
    this.visibleMs = 0;
    const blurs = this.blurs;
    this.blurs = 0;
    const act = Math.min(dur, this.buckets.size * BUCKET);
    this.buckets.clear();

    const w: Omit<EvidenceWindow, 'sid' | 'seq' | 'prev'> = {
      v: WINDOW_VERSION,
      t0: Math.round(timeOrigin + start),
      dur: Math.round(dur),
      mono: Math.round(start),
      act: Math.round(act),
      vis: Math.round(Math.min(dur, vis)),
      blurs,
      e: { wd: webdriver ? 1 : 0, kd: this.keyDetail, zoom: zoomed ? 1 : 0, ...(this.coarse ? { tp: 1 } : {}) },
    };
    const k = this.kb;
    if (this.hold.length || k.downs || k.untyped || k.pasted || k.repeats || k.other) {
      const block: KeyBlock = { hold: this.hold.slice(0, 220), dd: this.dd.slice(0, 220), downs: k.downs, untyped: k.untyped, pasted: k.pasted, repeats: k.repeats, other: k.other };
      if (this.keyDetail === 'coarse') {
        block.cls = this.cls.slice(0, 220);
        // Sorted before sending: the lists say how this person's hands time their keys, not in which order the keys came.
        const h = this.hands;
        const asc = (xs: number[]) => xs.slice(0, 220).sort((a, b) => a - b);
        if (h.gs.length || h.gx.length || h.hl.length || h.hr.length) block.hand = { gs: asc(h.gs), gx: asc(h.gx), hl: asc(h.hl), hr: asc(h.hr) };
      }
      w.k = block;
    }
    this.hands = { gs: [], gx: [], hl: [], hr: [] };
    this.hold = []; this.dd = []; this.cls = [];
    this.kb = { downs: 0, untyped: 0, pasted: 0, repeats: 0, other: 0 };

    if (this.moves || strokes.length || this.clicks.length) {
      w.p = { moves: Math.min(20000, this.moves), strokes: strokes.slice(0, 60), clicks: this.clicks.slice(0, 60), pt: this.pointerType };
    }
    this.moves = 0;
    this.clicks = [];

    const g = this.gesture;
    if (g.length && now - g[g.length - 1].t > SCROLL_GAP_MS) this.endGesture();
    if (this.wheel.length || this.scrollNoInput || this.scrollBursts.length) {
      const gaps: number[] = [];
      let bursts = this.wheel.length ? 1 : 0;
      for (let i = 1; i < this.wheel.length; i++) {
        const g = this.wheel[i].t - this.wheel[i - 1].t;
        if (g > 300) bursts++; else gaps.push(g);
      }
      const sorted = [...gaps].sort((a, b) => a - b);
      const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
      const sd = gaps.length ? Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length) : 0;
      const counts = new Map<number, number>();
      for (const x of this.wheel) counts.set(x.d, (counts.get(x.d) ?? 0) + 1);
      w.s = {
        n: this.wheel.length,
        bursts,
        dist: Math.min(1e7, this.wheel.reduce((a, b) => a + b.d, 0)),
        dtm: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : 0,
        dtcv: mean > 0 ? Math.round((sd / mean) * 1000) / 1000 : 0,
        same: this.wheel.length ? Math.round((Math.max(...counts.values()) / this.wheel.length) * 1000) / 1000 : 0,
        noinput: this.scrollNoInput,
        ...(this.scrollBursts.length ? { b: this.scrollBursts } : {}),
      };
    }
    this.wheel = [];
    this.scrollBursts = [];
    this.scrollNoInput = 0;

    if (this.touchMoves || this.swipes.length || this.taps.length || this.multi || this.softGaps.length) {
      w.t = { n: Math.min(20000, this.touchMoves), swipes: this.swipes, taps: this.taps, multi: this.multi, kg: this.softGaps };
    }
    this.touchMoves = 0; this.swipes = []; this.taps = []; this.multi = 0; this.softGaps = [];

    const f = this.focus;
    if (f.n || f.dw.length || f.ret.length) w.f = f;
    this.focus = { n: 0, key: 0, ptr: 0, auto: 0, dw: [], ret: [] };

    const motion = this.motionBlock(dur);
    if (motion) w.m = motion;

    // Motion and focus alone never start a window: a phone in a pocket would otherwise report for ever.
    const hasInput = !!(w.k && (w.k.hold.length || w.k.untyped || w.k.pasted)) || !!(w.p && (w.p.strokes.length || w.p.clicks.length)) || !!w.s
      || !!(w.t && (w.t.swipes.length || w.t.taps.length || w.t.kg.length || w.t.multi));
    return hasInput ? w : null;
  }
}
