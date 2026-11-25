// The evidence window: what the browser SDK sends, every ~5 seconds.
//
// Privacy boundary, enforced by shape: a window holds timings and movement
// summaries only. There is no field that can carry a typed character, a key code,
// a pointer or touch coordinate, a URL, an element id or page text. The coarse key
// class (`cls`) and the hand summaries (`hand`) are optional and off unless the
// integrator turns them on. Device motion is off until the page asks for it.

export const WINDOW_VERSION = 1;

/** Coarse key classes. Only sent when the SDK runs with keyDetail: 'coarse'. */
export const KEY_CLASS = { letter: 0, digit: 1, space: 2, erase: 3, punct: 4, enter: 5 } as const;

/**
 * Timings split by the hand a key belongs to on a standard layout. Only sent with keyDetail: 'coarse'.
 * Every list is sorted, so the left/right order of the keys cannot be read back from it.
 */
export interface HandBlock {
  gs: number[]; // gaps (ms) between two keys of the same hand
  gx: number[]; // gaps (ms) between keys of different hands
  hl: number[]; // hold times (ms) of left-hand keys
  hr: number[]; // hold times (ms) of right-hand keys
}

export interface KeyBlock {
  /** Hold time (ms) of each completed key, in press order. */
  hold: number[];
  /** Ms since the previous key press. -1 for the first key of the session. Capped at 5000. */
  dd: number[];
  /** Optional coarse class per key (see KEY_CLASS). Never a key code. */
  cls?: number[];
  /** Optional hand summaries (see HandBlock). */
  hand?: HandBlock;
  /** Key presses seen (including ones still held at window end). */
  downs: number;
  /** Text-changing input events with no key press behind them (fill, autofill, drop). */
  untyped: number;
  /** Input events of paste type. Pasting is normal; it just yields no typing evidence. */
  pasted: number;
  /** Auto-repeat presses from a held key (excluded from hold/dd). */
  repeats: number;
  /** Modifier and navigation presses, counted but not timed into the sequence. */
  other: number;
}

/** One pointer movement between two pauses, summarised. No coordinates. */
export interface Stroke {
  d: number; // duration, ms
  n: number; // move events
  len: number; // path length, px
  ch: number; // straight-line distance start to end, px
  vm: number; // mean speed, px/s
  vx: number; // peak speed, px/s
  vcv: number; // coefficient of variation of segment speeds
  tp: number; // time of peak speed as a fraction of duration, 0..1
  v0: number; // speed of the first segment relative to peak, 0..1
  v1: number; // speed of the last segment relative to peak, 0..1
  acv: number; // sd of acceleration relative to peak speed per second
  ang: number; // mean absolute turning angle, rad
  flip: number; // share of consecutive turns that change direction, 0..1
  dev: number; // max perpendicular deviation from the chord, relative to chord
  jit: number; // fine-scale roughness: rms of second differences relative to step length
  pk: number; // speed peaks (sub-movements): hands correct course, generated paths have one
  dtm: number; // median ms between events
  dtcv: number; // coefficient of variation of ms between events
  frac: number; // share of events with non-integer coordinates, 0..1
  dir: number; // direction octant of the chord, 0..7
  end: number; // 0 = pause, 1 = button press, 2 = forced split / left page
}

export interface Click {
  dw: number; // press-to-release, ms
  pre: number; // ms between the last move and the press
  appr: number; // move events in the 500 ms before the press
  trav: number; // px between where the pointer was 500 ms earlier and the press
  ok: number; // 1 when the page had focus and the pointer was inside for the lookback
}

export interface PointerBlock {
  moves: number;
  strokes: Stroke[];
  clicks: Click[];
  /** 0 mouse, 1 touch, 2 pen. Movement rules apply to mouse only. */
  pt: number;
}

/** One finger movement across the screen, summarised like a pointer stroke, plus contact size and force. */
export type Swipe = Stroke & {
  ar: number; // mean contact radius, px (0 when the device does not report it)
  pr: number; // mean force, 0..1 (0 when the device does not report it)
};

export interface Tap {
  dw: number; // finger down to finger up, ms
  slop: number; // px the finger moved while down
  ar: number; // contact radius, px
  pr: number; // force, 0..1
  gap: number; // ms since the previous finger lifted, capped at 5000; -1 for the first
}

/** Touch-screen input. No coordinates, no targets. */
export interface TouchBlock {
  n: number; // touch move events
  swipes: Swipe[];
  taps: Tap[];
  multi: number; // gestures that used more than one finger (counted, not summarised)
  /** Ms between presses on the on-screen keyboard, in order, capped at 5000. Which key is never known. */
  kg: number[];
}

/** How focus moves between fields and how the person returns to the page. No field identity. */
export interface FocusBlock {
  n: number; // times focus moved to a field
  key: number; // ...right after a key press (Tab, Enter)
  ptr: number; // ...right after a click or tap
  auto: number; // ...with no input just before (the page or a script moved it)
  dw: number[]; // ms each field kept focus, capped at 60000
  ret: number[]; // ms from coming back to the page to the first input, capped at 60000
}

/** Device motion over the window, as averages. No sample stream. Only present after the page calls enableMotion(). */
export interface MotionBlock {
  n: number; // samples
  hz: number; // sample rate
  am: number; // mean movement of the device with gravity removed, m/s^2
  asd: number; // its standard deviation
  rm: number; // mean rotation rate, deg/s
  rsd: number; // its standard deviation
  tb: number; // mean front-to-back tilt, deg
  tg: number; // mean side-to-side tilt, deg
  tsd: number; // standard deviation of the front-to-back tilt, deg
  tc: number; // movement in the 150 ms after a finger lands, relative to the window average (0 = no touches)
}

/**
 * One scroll gesture with the wheel or trackpad: wheel events with no pause over 300 ms between them, summarised.
 * Sizes only, no direction and no position, so it says how the person scrolls, not where to.
 */
export interface ScrollBurst {
  d: number; // duration, first to last event, ms
  n: number; // wheel events
  dist: number; // total |delta|, px
  step: number; // median |delta| per event, px
  dtm: number; // median ms between events
  dtcv: number; // coefficient of variation of ms between events
  tail: number; // mean |delta| of the last third relative to the largest, 0..1 (trackpad momentum fades; wheel notches do not)
}

export interface ScrollBlock {
  n: number; // wheel / scroll events
  bursts: number;
  dist: number; // total |delta|, px
  dtm: number; // median ms between events inside bursts
  dtcv: number;
  same: number; // share of wheel events with an identical |delta|
  noinput: number; // scroll events with no wheel/key/touch/pointer input just before
  /** Finished scroll gestures (see ScrollBurst). Absent from SDKs older than this field. */
  b?: ScrollBurst[];
}

export interface EvidenceWindow {
  v: number;
  sid: string;
  seq: number;
  /** SHA-256 (hex) of the previous window's signed body; the session id for seq 1. */
  prev: string;
  t0: number; // client epoch ms at window start
  dur: number; // ms
  mono: number; // client monotonic clock at window start, ms
  act: number; // ms with any input (250 ms buckets)
  vis: number; // ms the page was visible and focused
  blurs: number;
  k?: KeyBlock;
  p?: PointerBlock;
  s?: ScrollBlock;
  t?: TouchBlock;
  f?: FocusBlock;
  m?: MotionBlock;
  /** tp: 1 when the device's main pointer is a finger (phone or tablet). */
  e: { wd: number; kd: 'timing' | 'coarse'; zoom: number; tp?: number };
}

export interface SignedWindow {
  /** The exact JSON text that was signed. The server hashes and verifies these bytes. */
  body: string;
  /** ECDSA P-256 / SHA-256 signature (IEEE P1363, base64url) by the session key. */
  sig: string;
}
