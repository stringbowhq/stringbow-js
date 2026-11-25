// Canonical JSON and request hashing. Runs in browsers and Node (WebCrypto only).
//
// The canonical form is what gets hashed into a permit, so it must be boring and
// unambiguous: object keys sorted by code unit, no whitespace, integers only
// (floats are rejected so "10.0" and "10" can never hash differently), strings
// NFC-normalised, no undefined / NaN / functions.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export class CanonicalError extends Error {}

export function canonicalize(value: unknown, path = '$', depth = 0): string {
  if (depth > 8) throw new CanonicalError(`${path}: nested too deeply`);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalError(`${path}: only safe integers are allowed (use minor units or strings)`);
      }
      return String(value);
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`, depth + 1)).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        if (obj[k] === undefined) throw new CanonicalError(`${path}.${k}: undefined is not allowed`);
        parts.push(JSON.stringify(k.normalize('NFC')) + ':' + canonicalize(obj[k], `${path}.${k}`, depth + 1));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new CanonicalError(`${path}: unsupported type ${typeof value}`);
  }
}

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function sha256Bytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** Everything that defines "this exact action". Change any field and the hash changes. */
export interface ActionRequest {
  /** Environment id the request is made in (binds sandbox vs live and the tenant). */
  env: string;
  subject: string;
  /** Who is at the controls according to the caller: the signed-in user or an agent acting for them. */
  actor: 'user' | 'agent';
  action: string;
  target: { kind: string; id: string };
  params: { [k: string]: Json };
  audience: string;
  nonce: string;
}

export const REQUEST_HASH_VERSION = 1;

export async function requestHash(req: ActionRequest): Promise<string> {
  const material = {
    v: REQUEST_HASH_VERSION,
    env: req.env,
    subject: req.subject,
    actor: req.actor,
    action: req.action,
    target: { kind: req.target.kind, id: req.target.id },
    params: req.params,
    audience: req.audience,
    nonce: req.nonce,
  };
  return sha256Hex('stringbow.request.v1\n' + canonicalize(material));
}

export function randomId(prefix: string, bytes = 12): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return `${prefix}_${b64url(b)}`;
}

/** Constant-time-ish string comparison for equal-length hex/base64 strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
