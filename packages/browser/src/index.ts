// @stringbow/browser — collects derived timing and movement summaries and talks to the
// Stringbow API with a short-lived browser token minted by your backend.
//
//   const sb = new StringbowBrowser({ apiUrl, getToken: () => fetch('/api/stringbow/token').then(r => r.json()).then(j => j.token) });
//   const me = await sb.me();
//   if (userSaidYes) { await sb.consent(true, 'notice-2026-11'); await sb.enroll({ onProgress }); }
//   await sb.observe();                 // on later visits
//   await sb.flush();                   // right before a protected action
//   await sb.completeChallenge(id, { confirm });

import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { b64url, sha256Hex, timezoneIsEuUk, type Assessment, type EvidenceWindow, type SignedWindow } from '@stringbow/core/sdk';
import { Collector, type KeyDetail, type TouchLike } from './collector.ts';

export { Collector, classify, isSensitiveTarget } from './collector.ts';
export type { KeyDetail } from './collector.ts';

export interface BrowserOptions {
  apiUrl: string;
  /** Returns a fresh browser token from your backend. Called again when the token is about to expire. */
  getToken: () => Promise<string>;
  /** 'timing' sends hold and gap timings only. 'coarse' adds a six-way key class (letter, digit, space, erase, punctuation, enter). */
  keyDetail?: KeyDetail;
  windowMs?: number;
  onError?: (e: StringbowBrowserError) => void;
}

export class StringbowBrowserError extends Error {
  constructor(public code: string, message?: string, public status = 0) {
    super(message ?? code);
  }
}

export interface Progress {
  keys: number; strokes: number; key_windows: number; pointer_windows: number;
  /** Finger gestures (swipes, taps, on-screen key presses) and the windows that held some. */
  touches: number; touch_windows: number;
  /** 'touch' on a phone or tablet, where enrollment is measured in finger gestures instead of keys and pointer movements. */
  mode: 'desktop' | 'touch';
  ready: boolean;
  target: { keys: number; strokes: number; keyWindows: number; pointerWindows: number; idleWindows: number; touches: number; touchWindows: number };
}
export interface Me {
  subject: { id: string; state: 'new' | 'declined' | 'enrolling' | 'enrolled' | 'revoked'; consent: { granted: boolean; notice_version: string; at: number; release?: boolean; state?: string } | null };
  /** `release_required`: the user is in Illinois, Texas, Washington or Colorado; consent needs `{ release: true }`. */
  enrollment: { allowed: boolean; reason: string; target: Progress['target']; release_required: boolean };
  passkeys: number;
  can_register_passkey: boolean;
  environment: 'sandbox' | 'live';
  server_time: number;
}
export interface ChallengeDetails {
  id: string; status: string; methods: string[]; expires_at: number;
  action: { key: string; name?: string; consequence?: string };
  target: { kind: string; id: string }; request_hash: string; passkeys: number;
}
export type Snapshot =
  | { kind: 'enrollment'; progress: Progress; flagged: string[] }
  | { kind: 'observation'; detail: 'full'; assessment: Assessment }
  | { kind: 'observation'; detail: 'coverage_only'; evidence: Assessment['evidence']; freshness_ms: number | null };

interface ActiveSession { id: string; kind: 'enrollment' | 'observation'; key: CryptoKey; seq: number; prev: string }

// A session survives reloads and moves between pages of the same tab. Its signing key is a
// non-extractable CryptoKey kept in IndexedDB; the tab is identified through sessionStorage.
const RESUME_MAX_IDLE_MS = 30 * 60_000;
interface Saved { tab: string; id: string; kind: 'enrollment' | 'observation'; keyDetail: KeyDetail; key: CryptoKey; at: number }

function tabId(): string | null {
  try {
    let t = sessionStorage.getItem('stringbow.tab');
    if (!t) { t = crypto.randomUUID(); sessionStorage.setItem('stringbow.tab', t); }
    return t;
  } catch { return null; }
}

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open('stringbow', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('sessions', { keyPath: 'tab' });
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const req = run(open.result.transaction('sessions', mode).objectStore('sessions'));
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
    } catch { resolve(null); }
  });
}

export class StringbowBrowser {
  private token: { value: string; exp: number } | null = null;
  private collector: Collector | null = null;
  private active: ActiveSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: SignedWindow[] = [];
  private sending: Promise<void> = Promise.resolve();
  private detach: (() => void) | null = null;
  private _paused = false;
  private onProgress: ((p: Progress, flagged: string[]) => void) | null = null;
  private keyDetail: KeyDetail;
  private windowMs: number;

  constructor(private o: BrowserOptions) {
    this.keyDetail = o.keyDetail ?? 'timing';
    this.windowMs = o.windowMs ?? 5000;
  }

  // ---------- transport ----------
  private async bearer(): Promise<string> {
    if (!this.token || this.token.exp - Date.now() < 60_000) {
      const value = await this.o.getToken();
      let exp = Date.now() + 300_000;
      try { exp = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch { /* keep default */ }
      this.token = { value, exp };
    }
    return this.token.value;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.o.apiUrl.replace(/\/$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${await this.bearer()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new StringbowBrowserError(json?.error?.code ?? 'http_error', json?.error?.message ?? `HTTP ${res.status}`, res.status);
    return json as T;
  }

  // ---------- account state ----------
  me(): Promise<Me> { return this.call('GET', '/v1/me'); }

  /**
   * Record the user's choice. `false` also withdraws: the baseline and all evidence are deleted.
   * Where `me().enrollment.release_required` is true, pass `{ release: true }` only after showing the full written
   * notice (purpose, retention, that Stringbow processes the data) and taking a separate opt-in to it.
   */
  async consent(granted: boolean, noticeVersion: string, opts: { release?: boolean } = {}): Promise<void> {
    if (!granted) { this.forget(); this.stop(); }
    await this.call('POST', '/v1/consent', { granted, notice_version: noticeVersion, ...(opts.release ? { release: true } : {}) });
  }

  /**
   * Local half of the region gate. The API applies the authoritative check from the region your backend supplies;
   * this one catches a device whose clock says EU or UK even when that region was missing or wrong.
   */
  regionGate(): { allowed: boolean; reason: string } {
    let tz: string | null = null;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* unknown */ }
    return timezoneIsEuUk(tz) ? { allowed: false, reason: 'region.timezone_eu_uk' } : { allowed: true, reason: 'ok' };
  }

  // ---------- sessions ----------
  get session(): { id: string; kind: 'enrollment' | 'observation' } | null {
    return this.active ? { id: this.active.id, kind: this.active.kind } : null;
  }
  get paused(): boolean { return this._paused; }

  /** Start the opt-in enrollment session. Requires consent(true, ...) first. */
  async enroll(opts: { onProgress?: (p: Progress, flagged: string[]) => void } = {}): Promise<{ id: string }> {
    this.onProgress = opts.onProgress ?? null;
    return this.open('enrollment');
  }

  /** Start observing an enrolled user so fresh evidence exists when a protected action comes. */
  async observe(): Promise<{ id: string }> {
    this.onProgress = null;
    return this.open('observation');
  }

  private async open(kind: 'enrollment' | 'observation'): Promise<{ id: string }> {
    const gate = this.regionGate();
    if (!gate.allowed) throw new StringbowBrowserError(gate.reason, 'Behavioural evidence is not collected in this region.');
    this.stop();
    // stop() during the awaits below (a newer open(), or the page replacing this instance) cancels this open.
    const gen = this.gen;
    const superseded = () => { if (gen !== this.gen) throw new StringbowBrowserError('session.superseded', 'A newer session replaced this one.'); };
    const tab = tabId();
    // Pick the previous session of this tab up again if the server agrees it is still open and recent.
    const saved = tab ? await idb<Saved>('readonly', (st) => st.get(tab)) : null;
    superseded();
    if (saved && saved.kind === kind && saved.keyDetail === this.keyDetail && Date.now() - saved.at < RESUME_MAX_IDLE_MS) {
      try {
        const st = await this.call<{ id: string; kind: string; last_seq: number; last_hash: string; ended: boolean }>('GET', `/v1/sessions/${saved.id}`);
        superseded();
        if (!st.ended && st.kind === kind) this.active = { id: saved.id, kind, key: saved.key, seq: st.last_seq, prev: st.last_hash };
      } catch (e) { if ((e as StringbowBrowserError).code === 'session.superseded') throw e; /* otherwise gone or not ours: start a new one */ }
    }
    if (!this.active) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      const res = await this.call<{ id: string; window_ms: number }>('POST', '/v1/sessions', {
        kind, key_detail: this.keyDetail, public_key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
        client_time: performance.timeOrigin + performance.now(),
      });
      superseded();
      this.active = { id: res.id, kind, key: pair.privateKey, seq: 0, prev: res.id };
      if (tab) void idb('readwrite', (st) => st.put({ tab, id: res.id, kind, keyDetail: this.keyDetail, key: pair.privateKey, at: Date.now() } satisfies Saved));
    }
    const res = { id: this.active.id };
    // A phone or tablet: fingers are the main pointer and the keyboard is on screen.
    const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
    this.collector = new Collector({ keyDetail: this.keyDetail, now: performance.now(), visible: this.isActivePage(), coarsePointer });
    if (this._paused) this.collector.setPaused(true, performance.now());
    this.attach();
    this.timer = setInterval(() => { void this.rotate(); }, this.windowMs);
    return { id: res.id };
  }

  private motionOn = false;
  private motionHandler: ((e: DeviceMotionEvent) => void) | null = null;

  private attachMotion(): void {
    if (this.motionHandler || typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return;
    this.motionHandler = (e) => {
      const a = e.acceleration, g = e.accelerationIncludingGravity, r = e.rotationRate;
      this.collector?.motionSample({
        timeStamp: e.timeStamp,
        ax: a?.x ?? null, ay: a?.y ?? null, az: a?.z ?? null,
        gx: g?.x ?? null, gy: g?.y ?? null, gz: g?.z ?? null,
        rx: r?.alpha ?? null, ry: r?.beta ?? null, rz: r?.gamma ?? null,
      });
    };
    window.addEventListener('devicemotion', this.motionHandler, { passive: true });
  }

  /**
   * Start using the device's motion sensor (how the phone is held and how it moves under the fingers).
   * Off until you call this. Call it from a tap or click: iOS shows its own permission prompt and only
   * allows that from a user gesture. Resolves to false when the device has no sensor or the person said no.
   * Only a few averages per window are sent, never the samples.
   */
  async enableMotion(): Promise<boolean> {
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return false;
    const ask = (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    if (typeof ask === 'function') {
      try { if ((await ask.call(DeviceMotionEvent)) !== 'granted') return false; } catch { return false; }
    }
    this.motionOn = true;
    if (this.collector) this.attachMotion();
    return true;
  }

  /** Stop using the motion sensor. */
  disableMotion(): void {
    this.motionOn = false;
    if (this.motionHandler) window.removeEventListener('devicemotion', this.motionHandler);
    this.motionHandler = null;
  }

  private isActivePage(): boolean {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  private attach(): void {
    const c = this.collector!;
    const opt: AddEventListenerOptions = { capture: true, passive: true };
    const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
      document.addEventListener(type, fn as EventListener, opt);
      return () => document.removeEventListener(type, fn as EventListener, opt);
    };
    const vis = () => c.visibility(this.isActivePage(), performance.now());
    const gone = () => c.pointerGone();
    const offs = [
      on('keydown', (e) => c.keydown(e)),
      on('keyup', (e) => c.keyup(e)),
      on('input', (e) => c.input(e as InputEvent)),
      on('pointermove', (e) => c.pointermove(e)),
      on('pointerdown', (e) => c.pointerdown(e, document.hasFocus())),
      on('pointerup', (e) => c.pointerup(e)),
      on('wheel', (e) => c.wheelEvent(e)),
      on('scroll', (e) => c.scrollEvent(e)),
      on('visibilitychange', vis),
      on('touchstart', (e) => c.touchStart(touchLike(e))),
      on('touchmove', (e) => c.touchMove(touchLike(e))),
      on('touchend', (e) => c.touchEnd(touchLike(e))),
      on('touchcancel', (e) => c.touchEnd(touchLike(e), true)),
      on('focusin', (e) => c.focusIn(e)),
      on('focusout', (e) => c.focusOut(e)),
    ];
    if (this.motionOn) this.attachMotion();
    window.addEventListener('blur', vis);
    window.addEventListener('focus', vis);
    document.documentElement.addEventListener('mouseleave', gone);
    this.detach = () => {
      offs.forEach((off) => off());
      if (this.motionHandler) window.removeEventListener('devicemotion', this.motionHandler);
      this.motionHandler = null;
      window.removeEventListener('blur', vis);
      window.removeEventListener('focus', vis);
      document.documentElement.removeEventListener('mouseleave', gone);
    };
  }

  /** Stop collecting until resume(). Nothing that happens while paused is summarised or sent. */
  pause(): void {
    this._paused = true;
    this.collector?.setPaused(true, performance.now());
  }
  resume(): void {
    this._paused = false;
    this.collector?.setPaused(false, performance.now());
  }

  private chain: Promise<void> = Promise.resolve();
  private gen = 0;

  /** Close the current window, sign it and queue it. Serialised so sequence numbers and the hash chain stay in order. */
  private rotate(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const s = this.active;
      const c = this.collector;
      if (!s || !c) return;
      const zoomed = !Number.isInteger(window.devicePixelRatio) || (window.visualViewport ? Math.abs(window.visualViewport.scale - 1) > 0.01 : false);
      const w = c.take(performance.now(), performance.timeOrigin, (navigator as Navigator).webdriver === true, zoomed);
      if (!w) return;
      const full: EvidenceWindow = { ...w, sid: s.id, seq: s.seq + 1, prev: s.prev };
      const body = JSON.stringify(full);
      const bytes = new TextEncoder().encode(body);
      const [hash, sig] = await Promise.all([sha256Hex(body), crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, s.key, bytes)]);
      if (this.active !== s) return;
      s.seq += 1;
      s.prev = hash;
      this.queue.push({ body, sig: b64url(sig) });
      this.send();
    }).catch((e) => { this.o.onError?.(new StringbowBrowserError('collector.error', String(e))); });
    return this.chain;
  }

  private send(): void {
    this.sending = this.sending.then(async () => {
      const s = this.active;
      if (!s || !this.queue.length) return;
      const batch = this.queue.slice(0, 12);
      try {
        const r = await this.call<{ accepted: number; rejected: { seq: number | null; reason: string }[]; flagged: string[]; progress?: Progress }>('POST', `/v1/sessions/${s.id}/windows`, { windows: batch });
        this.queue.splice(0, batch.length);
        if (r.progress && this.onProgress) this.onProgress(r.progress, r.flagged);
        const fatal = r.rejected.find((x) => x.reason !== 'replayed');
        if (fatal) {
          this.o.onError?.(new StringbowBrowserError(`window.${fatal.reason}`, 'Evidence was rejected; the session will restart.'));
          this.forget();
          if (s.kind === 'observation') { this.queue = []; await this.open('observation').catch(() => {}); }
        }
      } catch (e) {
        const err = e as StringbowBrowserError;
        // Network trouble: keep the queue (bounded) and try again on the next window.
        if (err.status >= 400 && err.status < 500) { this.queue = []; this.o.onError?.(err); }
        else if (this.queue.length > 60) this.queue.splice(0, this.queue.length - 60);
      }
    });
  }

  /** Close the current window now and wait until everything collected so far has been delivered. Call before a protected action. */
  async flush(): Promise<void> {
    await this.rotate();
    this.send();
    await this.sending;
  }

  /** Finish enrollment once progress.ready is true. Resolves to whether the baseline was created. */
  async finishEnrollment(): Promise<{ enrolled: boolean; progress: Progress }> {
    if (!this.active || this.active.kind !== 'enrollment') throw new StringbowBrowserError('session.not_enrollment');
    await this.flush();
    const r = await this.call<{ enrolled: boolean; progress: Progress }>('POST', `/v1/sessions/${this.active.id}/finish`, {});
    if (r.enrolled) { this.forget(); this.stop(); }
    return r;
  }

  /** What the server currently makes of this session. In live environments this is coverage only unless the workspace opts in. */
  async snapshot(): Promise<Snapshot | null> {
    if (!this.active) return null;
    return this.call('GET', `/v1/sessions/${this.active.id}/snapshot`);
  }

  /** Forget the saved session of this tab, so the next enroll()/observe() starts a new one. */
  private forget(): void {
    const tab = tabId();
    if (tab) void idb('readwrite', (st) => st.delete(tab));
  }

  /** Stop collecting on this page. The session itself can be resumed by the next page of this tab. */
  stop(): void {
    this.gen++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detach?.();
    this.detach = null;
    this.collector = null;
    this.active = null;
    this.queue = [];
  }

  // ---------- passkeys and challenges ----------
  /**
   * Register a passkey for this user. Only works with a token your backend minted with allowPasskeyRegistration.
   *
   * A user who already has a passkey confirms with it first, so this shows two prompts: the existing passkey,
   * then the new one. Someone who only holds the session cannot add a passkey of their own.
   */
  async registerPasskey(): Promise<{ registered: boolean; passkeys: number }> {
    const start = () => this.call<any>('POST', '/v1/passkeys/registration/options', {});
    let optionsJSON: any;
    try {
      optionsJSON = await start();
    } catch (e) {
      if (!(e instanceof StringbowBrowserError) || e.code !== 'passkey.confirmation_required') throw e;
      const confirm = await this.call<any>('POST', '/v1/passkeys/registration/confirm/options', {});
      const proof = await startAuthentication({ optionsJSON: confirm });
      await this.call('POST', '/v1/passkeys/registration/confirm/verify', { response: proof });
      optionsJSON = await start();
    }
    const response = await startRegistration({ optionsJSON });
    return this.call('POST', '/v1/passkeys/registration/verify', { response });
  }

  challengeDetails(id: string): Promise<ChallengeDetails> {
    return this.call('GET', `/v1/challenges/${encodeURIComponent(id)}`);
  }

  /**
   * Complete an action-bound challenge. `confirm` runs first with the server's view of the challenge:
   * show it next to the request details your own backend saved, and return false to cancel.
   * The passkey signs a value derived from the exact request hash, so approval cannot be moved to another request.
   *
   * A challenge whose only method is `customer` is completed by your own step-up and your backend, not here:
   * this returns `{ status: 'customer_required' }` without prompting.
   */
  async completeChallenge(id: string, opts: { confirm?: (d: ChallengeDetails) => boolean | Promise<boolean>; method?: 'passkey' | 'sandbox_confirm' } = {}): Promise<{ status: 'passed' | 'cancelled' | 'customer_required'; decision?: string; decision_id?: string }> {
    const details = await this.challengeDetails(id);
    if (details.methods.includes('customer') && !details.methods.includes(opts.method ?? 'passkey')) return { status: 'customer_required' };
    if (opts.confirm && !(await opts.confirm(details))) return { status: 'cancelled' };
    if ((opts.method ?? 'passkey') === 'sandbox_confirm') return this.call('POST', `/v1/challenges/${encodeURIComponent(id)}/sandbox-confirm`, {});
    const optionsJSON = await this.call<any>('POST', `/v1/challenges/${encodeURIComponent(id)}/passkey/options`, {});
    const response = await startAuthentication({ optionsJSON });
    return this.call('POST', `/v1/challenges/${encodeURIComponent(id)}/passkey/verify`, { response });
  }
}

function touchLike(e: TouchEvent): TouchLike {
  const changed: TouchLike['changed'] = [];
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    changed.push({ id: t.identifier, x: t.clientX, y: t.clientY, rx: t.radiusX, ry: t.radiusY, force: t.force });
  }
  return { timeStamp: e.timeStamp, isTrusted: e.isTrusted, changed, active: e.touches.length };
}
