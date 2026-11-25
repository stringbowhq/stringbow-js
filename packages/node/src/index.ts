// @stringbow/node — the server-side SDK.
//
//   const sb = new Stringbow({ apiKey: process.env.STRINGBOW_KEY!, baseUrl: 'http://localhost:8787' });
//   const d  = await sb.authorize({ ...savedRequest, idempotencyKey: pending.id });
//   if (d.decision === 'challenge') -> hand d.challenge.id to the browser, later: sb.resolve(savedRequest, d.id)
//   const ok = await sb.redeem(permit, savedRequest);   // verify offline, then consume once online
//   if (ok.valid) execute();                              // and only then
//   await sb.reportOutcome(d.id, 'executed');

import { createHmac, timingSafeEqual } from 'node:crypto';
import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';
import { JWKS_PATH, PERMIT_MAX_TTL_S, PERMIT_TYP, randomId, requestHash, safeEqual, type ActionRequest, type Assessment, type CustomerChallengeKind, type Decision, type Json } from '@stringbow/core/sdk';

export { requestHash } from '@stringbow/core/sdk';
export type { ActionRequest, Assessment, Decision } from '@stringbow/core/sdk';

/** The request your backend froze before asking for a decision. Verification always goes back to this. */
export interface SavedRequest {
  subject: string;
  action: string;
  target: { kind: string; id: string };
  params: { [k: string]: Json };
  audience: string;
  nonce: string;
  actor?: 'user' | 'agent';
}

export interface AuthorizeInput extends Omit<SavedRequest, 'nonce'> {
  /** Reuse the same key (and the same request) when retrying. */
  idempotencyKey: string;
  /** Observation session id from the browser SDK, when the user has one. */
  session?: string | null;
  /** Leave empty to have the SDK generate one. Persist the value returned in `binding.nonce`. */
  nonce?: string;
  requestedAt?: number;
}

export interface DecisionResult {
  id: string;
  decision: Decision;
  /** False in shadow mode: the decision is recorded but carries no permit and must not gate anything. */
  enforced: boolean;
  mode: 'shadow' | 'enforce';
  reasons: string[];
  assessment: Assessment;
  action: string;
  policy: { version: number; digest: string };
  binding: { request_hash: string; nonce: string };
  subject: string;
  parent: string | null;
  challenge: { id: string; status: string; methods: string[]; expires_at: number; method_used?: string | null; method_detail?: string | null } | null;
  permit: string | null;
  permit_state: 'active' | 'redeemed' | 'revoked' | 'expired' | null;
  /** Present on an enforced hold: a person in the console releases or rejects it. */
  review: { status: 'pending' | 'released' | 'rejected'; decided_by: string | null; note: string | null; decided_at: number | null } | null;
  final: DecisionResult | null;
  outcome: { outcome: string; note: string | null; at: number } | null;
  created_at: number;
  idempotent_replay?: boolean;
}

export interface PermitExpectations {
  issuer: string;
  tenant: string;
  environment: string;
  kind: 'sandbox' | 'live';
  audience: string;
  action: string;
  subject: string;
  /** Hash recomputed from YOUR saved request, never taken from the permit or the browser. */
  requestHash: string;
  now?: number;
}

export type VerifyReason =
  | 'malformed' | 'unsupported_alg' | 'unknown_key' | 'bad_signature' | 'issuer_mismatch' | 'expired' | 'not_yet_valid' | 'ttl_too_long'
  | 'audience_mismatch' | 'tenant_mismatch' | 'environment_mismatch' | 'environment_kind_mismatch' | 'action_mismatch' | 'subject_mismatch'
  | 'request_mismatch' | 'already_redeemed' | 'revoked' | 'unknown_permit' | 'subject_revoked' | 'unreachable';

export interface VerifyOutcome {
  valid: boolean;
  reason?: VerifyReason | string;
  claims?: Record<string, any>;
}

export type Jwks = { keys: (JWK & { 'stringbow:kind'?: string })[] };

/** Pure, offline permit check: signature plus every binding. Makes no network request. */
export async function verifyPermitOffline(permit: string, jwks: Jwks, ex: PermitExpectations): Promise<VerifyOutcome> {
  let header;
  try {
    header = decodeProtectedHeader(permit);
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (header.alg !== 'ES256') return { valid: false, reason: 'unsupported_alg' };
  if (header.typ !== PERMIT_TYP || typeof header.kid !== 'string') return { valid: false, reason: 'malformed' };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { valid: false, reason: 'unknown_key' };
  let c: Record<string, any>;
  try {
    const { payload } = await compactVerify(permit, await importJWK(jwk, 'ES256'), { algorithms: ['ES256'] });
    c = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { valid: false, reason: 'bad_signature' };
  }
  const now = Math.floor((ex.now ?? Date.now()) / 1000);
  const no = (reason: VerifyReason): VerifyOutcome => ({ valid: false, reason, claims: c });
  if (c.iss !== ex.issuer) return no('issuer_mismatch');
  // Sandbox and live permits are signed by different keys; both the key and the claim must match the expected kind.
  if (c.kind !== ex.kind || (jwk['stringbow:kind'] !== undefined && jwk['stringbow:kind'] !== ex.kind)) return no('environment_kind_mismatch');
  if (c.ten !== ex.tenant) return no('tenant_mismatch');
  if (c.env !== ex.environment) return no('environment_mismatch');
  if (typeof c.exp !== 'number' || typeof c.iat !== 'number') return no('malformed');
  if (c.exp - c.iat > PERMIT_MAX_TTL_S) return no('ttl_too_long');
  if (c.iat > now + 60) return no('not_yet_valid');
  if (c.exp <= now) return no('expired');
  if (c.aud !== ex.audience) return no('audience_mismatch');
  if (c.act !== ex.action) return no('action_mismatch');
  if (c.sub !== ex.subject) return no('subject_mismatch');
  if (typeof c.rqh !== 'string' || !safeEqual(c.rqh, ex.requestHash)) return no('request_mismatch');
  return { valid: true, claims: c };
}

export interface WebhookEvent<T = Record<string, unknown>> { id: string; type: string; created: number; environment: string; data: T }

/**
 * Verify a webhook and return its event. Pass the raw request body exactly as received (not re-serialised JSON),
 * the `Stringbow-Signature` header, and the endpoint's signing secret. Throws on a bad or stale signature.
 * Deduplicate on `event.id`: a delivery can arrive more than once.
 */
export function verifyWebhook<T = Record<string, unknown>>(rawBody: string, signatureHeader: string | null | undefined, secret: string, opts: { toleranceSeconds?: number; now?: number } = {}): WebhookEvent<T> {
  const parts = Object.fromEntries(String(signatureHeader ?? '').split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) throw new StringbowError(400, 'webhook.signature_missing', 'Missing or malformed Stringbow-Signature header.');
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new StringbowError(400, 'webhook.signature_invalid', 'Webhook signature does not match.');
  if (Math.abs((opts.now ?? Date.now()) / 1000 - t) > (opts.toleranceSeconds ?? 300)) throw new StringbowError(400, 'webhook.stale', 'Webhook timestamp is outside the tolerance.');
  return JSON.parse(rawBody) as WebhookEvent<T>;
}

export class StringbowError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class Stringbow {
  private who: Promise<{ tenant: string; environment: string; kind: 'sandbox' | 'live'; issuer: string; role: string }> | null = null;
  private keys: { at: number; jwks: Jwks } | null = null;
  private f: typeof fetch;

  constructor(private o: ClientOptions) {
    if (!o.apiKey || !o.baseUrl) throw new Error('Stringbow: apiKey and baseUrl are required');
    this.f = o.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 10_000);
    try {
      const res = await this.f(this.o.baseUrl.replace(/\/$/, '') + path, {
        method, signal: ctl.signal,
        headers: { authorization: `Bearer ${this.o.apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new StringbowError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `HTTP ${res.status}`);
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Which tenant and environment this key belongs to. Cached. */
  whoami() {
    this.who ??= this.call('GET', '/v1/whoami');
    return this.who;
  }

  upsertSubject(externalRef: string) {
    return this.call<{ id: string; state: string; passkeys: number; [k: string]: unknown }>('POST', '/v1/subjects', { external_ref: externalRef });
  }
  getSubject(id: string) {
    return this.call<{ id: string; state: string; passkeys: number; [k: string]: unknown }>('GET', `/v1/subjects/${encodeURIComponent(id)}`);
  }
  resetSubject(id: string) {
    return this.call('POST', `/v1/subjects/${encodeURIComponent(id)}/reset`, {});
  }
  deleteSubject(id: string) {
    return this.call('DELETE', `/v1/subjects/${encodeURIComponent(id)}`);
  }
  /**
   * Remove every passkey of a subject. For YOUR account recovery, after you confirmed the user some other way
   * (they lost the device their passkey is on). The next passkey they register is a first one again, so it needs
   * no confirmation from an existing passkey: only call this when you are sure who you are talking to.
   */
  removePasskeys(id: string) {
    return this.call<{ id: string; removed: number; passkeys: number }>('DELETE', `/v1/subjects/${encodeURIComponent(id)}/passkeys`);
  }

  /**
   * Mint a short-lived token for the browser SDK. Call this from an authenticated route only.
   * `region` is where the end user is (e.g. from your CDN's geo headers); without it enrollment is refused.
   */
  browserToken(input: { subject: string; origin: string; region?: { country?: string | null; subdivision?: string | null } | null; allowPasskeyRegistration?: boolean }) {
    return this.call<{ token: string; expires_at: number; subject: string; enrollment: { allowed: boolean; reason: string; state: string; release_required: boolean } }>('POST', '/v1/browser-tokens', {
      subject: input.subject, origin: input.origin, region: input.region ?? null, allow_passkey_registration: input.allowPasskeyRegistration === true,
    });
  }

  /** The hash that binds a permit to this exact request, computed locally. */
  async hash(saved: SavedRequest): Promise<string> {
    const { environment } = await this.whoami();
    return requestHash(this.toRequest(saved, environment));
  }

  private toRequest(s: SavedRequest, env: string): ActionRequest {
    return { env, subject: s.subject, actor: s.actor ?? 'user', action: s.action, target: s.target, params: s.params, audience: s.audience, nonce: s.nonce };
  }

  /** Ask for a decision about one exact request. Persist `binding` with your pending request before doing anything else. */
  async authorize(input: AuthorizeInput): Promise<DecisionResult> {
    const nonce = input.nonce ?? randomId('n', 18);
    const saved: SavedRequest = { subject: input.subject, action: input.action, target: input.target, params: input.params, audience: input.audience, nonce, actor: input.actor };
    const local = await this.hash(saved);
    const d = await this.call<DecisionResult>('POST', '/v1/decisions', {
      subject: input.subject, session: input.session ?? null, action: input.action, target: input.target, params: input.params, audience: input.audience,
      actor: input.actor ?? 'user', nonce, idempotency_key: input.idempotencyKey, requested_at: input.requestedAt ?? Date.now(),
    });
    // The server must have bound the same request we sent.
    if (!safeEqual(d.binding.request_hash, local)) throw new StringbowError(500, 'binding.mismatch', 'The API bound a different request than the one submitted. Do not proceed.');
    return d;
  }

  getDecision(id: string) {
    return this.call<DecisionResult>('GET', `/v1/decisions/${encodeURIComponent(id)}`);
  }

  /**
   * After a challenge: fetch the original decision by the id YOU stored (never one supplied by the browser),
   * follow it to its final result and check that result still describes the saved request.
   */
  async resolve(saved: SavedRequest, originalDecisionId: string): Promise<{ decision: Decision; permit: string | null; decisionId: string; pending: boolean; reasons: string[] }> {
    const root = await this.getDecision(originalDecisionId);
    const expected = await this.hash(saved);
    const check = (d: DecisionResult) => {
      if (!safeEqual(d.binding.request_hash, expected) || d.subject !== saved.subject || d.action !== saved.action) {
        throw new StringbowError(409, 'binding.mismatch', 'The decision does not describe the saved request.');
      }
    };
    check(root);
    if (root.final) {
      if (root.final.parent !== root.id) throw new StringbowError(409, 'binding.mismatch', 'Follow-up decision does not belong to the original.');
      check(root.final);
      return { decision: root.final.decision, permit: root.final.permit, decisionId: root.final.id, pending: false, reasons: root.final.reasons };
    }
    // Still open: a challenge the user has not completed, or a hold nobody has reviewed yet.
    const pending = (root.decision === 'challenge' && root.challenge?.status === 'pending') || (root.decision === 'hold' && root.review?.status === 'pending');
    return { decision: root.decision, permit: root.permit, decisionId: root.id, pending, reasons: root.reasons };
  }

  /**
   * Report that YOUR step-up (your own passkey, authenticator app, ...) confirmed the saved request. Only for policies
   * whose challenge methods include `customer`. Call it from your backend after your own check succeeded, with the
   * request and decision id YOU stored. Stringbow records `kind` but cannot verify it: the strength of this
   * confirmation is the strength of your step-up. Then call `resolve` to get the permit.
   */
  async completeChallenge(saved: SavedRequest, originalDecisionId: string, opts: { kind: CustomerChallengeKind; verifiedAt?: number }): Promise<{ status: string; decision: Decision; decision_id: string }> {
    const root = await this.getDecision(originalDecisionId);
    const expected = await this.hash(saved);
    if (!safeEqual(root.binding.request_hash, expected) || root.subject !== saved.subject || root.action !== saved.action) {
      throw new StringbowError(409, 'binding.mismatch', 'The decision does not describe the saved request.');
    }
    if (!root.challenge) throw new StringbowError(409, 'challenge.not_pending', 'This decision has no challenge to complete.');
    return this.call('POST', `/v1/challenges/${encodeURIComponent(root.challenge.id)}/complete`, { request_hash: expected, kind: opts.kind, verified_at: opts.verifiedAt ?? Date.now() });
  }

  private async jwks(force = false): Promise<Jwks> {
    if (!force && this.keys && Date.now() - this.keys.at < 300_000) return this.keys.jwks;
    // Keys come from the configured service origin only, never from a URL inside the permit.
    const res = await this.f(this.o.baseUrl.replace(/\/$/, '') + JWKS_PATH);
    if (!res.ok) throw new StringbowError(res.status, 'jwks.unavailable', 'Could not fetch permit verification keys.');
    this.keys = { at: Date.now(), jwks: (await res.json()) as Jwks };
    return this.keys.jwks;
  }

  /** Verify signature and bindings against the saved request. Does not consume the permit. */
  async verify(permit: string, saved: SavedRequest, opts: { now?: number } = {}): Promise<VerifyOutcome> {
    const who = await this.whoami();
    const ex: PermitExpectations = {
      issuer: who.issuer, tenant: who.tenant, environment: who.environment, kind: who.kind, audience: saved.audience, action: saved.action,
      subject: saved.subject, requestHash: await this.hash(saved), now: opts.now,
    };
    let out = await verifyPermitOffline(permit, await this.jwks(), ex);
    if (!out.valid && out.reason === 'unknown_key') out = await verifyPermitOffline(permit, await this.jwks(true), ex);
    return out;
  }

  /**
   * Verify, then consume the permit exactly once online. Execute the action only when this returns valid: true.
   * Any error, timeout or ambiguous answer means: do not execute.
   */
  async redeem(permit: string, saved: SavedRequest, opts: { now?: number } = {}): Promise<VerifyOutcome & { permitId?: string }> {
    const offline = await this.verify(permit, saved, opts);
    if (!offline.valid) return offline;
    try {
      const r = await this.call<{ valid: boolean; reason?: string; permit?: { id: string } }>('POST', '/v1/permits/verify', {
        permit, redeem: true, expect: { audience: saved.audience, action: saved.action, request_hash: await this.hash(saved), subject: saved.subject },
      });
      return { valid: r.valid === true, reason: r.reason, claims: offline.claims, permitId: r.permit?.id };
    } catch {
      return { valid: false, reason: 'unreachable' };
    }
  }

  /** Tell Stringbow what your application actually did. Idempotent; a contradictory report is rejected. */
  reportOutcome(decisionId: string, outcome: 'executed' | 'not_executed' | 'failed' | 'overridden', note?: string) {
    return this.call<{ decision: string; outcome: string; at: number; repeated: boolean }>('POST', `/v1/decisions/${encodeURIComponent(decisionId)}/outcome`, { outcome, ...(note ? { note } : {}) });
  }
}
