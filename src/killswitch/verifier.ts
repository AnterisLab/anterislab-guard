/**
 * AnterisLab Guard — client-side kill-switch verification.
 *
 * This is the piece that makes the kill switch safe **on an untrusted network**. The client never
 * trusts a plain JSON body: it trusts only a compact JWS whose signature it verifies locally, with
 * a public key it obtained from the issuer's JWKS. A hostile proxy, a poisoned DNS answer, a
 * compromised CDN or a rogue internal service can therefore *deny* the client a state (which fails
 * closed) but cannot tell it "RUNNING" while the control plane says HALTED.
 *
 * Verification order is identical to the server's and deliberately strict:
 *   algorithm allow-list → key resolved by kid → signature over the exact received bytes →
 *   structural claims → audience/issuer/subject → time window and TTL cap → epoch anti-rollback →
 *   scope coverage.
 *
 * The algorithm allow-list is a *constructor* parameter and defaults to EdDSA only. HS256 exists
 * for single-process self-hosting but is never enabled implicitly, because accepting both
 * algorithms in one verifier is the classic key-confusion footgun.
 */

import { b64uToBytes, utf8Encode } from '../shared/base64url.js';
import {
  CLAIM_BOUNDS,
  KILL_SWITCH_LIMITS,
  KILL_SWITCH_TOKEN_TYP,
  KILL_SWITCH_TOKEN_VERSION,
  type KillSwitchClaims,
} from '../shared/killswitch-types.js';
import {
  decodeProtectedHeader,
  parseKillSwitchClaims,
  splitCompactJws,
  validateClaimSet,
  type VerificationKey,
  type VerifyOptions,
  type VerifyResult,
} from '../shared/killswitch-token.js';
import { KillSwitchConfigError, KillSwitchStateInvalidError } from './errors.js';

export interface JwksDocument {
  keys: Array<{
    kty: string;
    crv?: string;
    x?: string;
    k?: string;
    kid?: string;
    alg?: string;
    use?: string;
    status?: 'active' | 'retired';
  }>;
}

export interface SubtleLike {
  importKey(
    format: string,
    keyData: BufferSource,
    algorithm: { name: string; hash?: string; namedCurve?: string },
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  verify(algorithm: { name: string }, key: unknown, signature: BufferSource, data: BufferSource): Promise<boolean>;
}

function resolveSubtle(): SubtleLike {
  const candidate = (globalThis as { crypto?: { subtle?: unknown } }).crypto;
  if (!candidate || !candidate.subtle) {
    throw new KillSwitchConfigError(
      'no WebCrypto implementation found. Node >= 18, every modern browser and every edge runtime provide ' +
        'globalThis.crypto.subtle; the kill switch refuses to fall back to an unverified transport.',
    );
  }
  return candidate.subtle as SubtleLike;
}

/**
 * Holds the public keys the client is willing to trust. Only `use: 'sig'` (or an absent `use`) and
 * a key type matching the configured algorithm is accepted: a JWKS entry flagged for encryption
 * must never be usable as a signature key.
 */
export class KillSwitchKeyStore {
  private readonly keys = new Map<string, VerificationKey>();
  private jwksFetchedAt = 0;

  constructor(private readonly allowedAlgorithms: readonly string[] = ['EdDSA']) {}

  /** The algorithm allow-list this store was built with. */
  allowsAlgorithm(alg: string): boolean {
    return this.allowedAlgorithms.includes(alg);
  }

  static fromJwks(document: JwksDocument, allowedAlgorithms: readonly string[] = ['EdDSA']): KillSwitchKeyStore {
    const store = new KillSwitchKeyStore(allowedAlgorithms);
    store.loadJwks(document);
    return store;
  }

  loadJwks(document: JwksDocument): number {
    if (typeof document !== 'object' || document === null || !Array.isArray(document.keys)) {
      throw new KillSwitchStateInvalidError('JWKS document has no `keys` array');
    }
    if (document.keys.length > 64) {
      throw new KillSwitchStateInvalidError(`JWKS document declares ${document.keys.length} keys (maximum 64)`);
    }
    let loaded = 0;
    for (const entry of document.keys) {
      if (typeof entry !== 'object' || entry === null) continue;
      if (!entry.kid || typeof entry.kid !== 'string') continue;
      if (entry.use !== undefined && entry.use !== 'sig') continue;

      if (entry.kty === 'OKP' && entry.crv === 'Ed25519' && typeof entry.x === 'string') {
        if (!this.allowedAlgorithms.includes('EdDSA')) continue;
        if (entry.alg !== undefined && entry.alg !== 'EdDSA') continue;
        this.keys.set(entry.kid, { kty: 'OKP', crv: 'Ed25519', x: entry.x, kid: entry.kid });
        loaded += 1;
      } else if (entry.kty === 'oct' && typeof entry.k === 'string') {
        if (!this.allowedAlgorithms.includes('HS256')) continue;
        if (entry.alg !== undefined && entry.alg !== 'HS256') continue;
        this.keys.set(entry.kid, { kty: 'oct', k: entry.k, kid: entry.kid });
        loaded += 1;
      }
    }
    this.jwksFetchedAt = Math.floor(Date.now() / 1000);
    return loaded;
  }

  /** Register a single key directly (pinning a key without a round trip, or test fixtures). */
  addKey(kid: string, key: VerificationKey): void {
    this.keys.set(kid, key);
  }

  resolve(kid: string, alg: string): VerificationKey | null {
    const key = this.keys.get(kid);
    if (!key) return null;
    if (alg === 'EdDSA' && key.kty !== 'OKP') return null;
    if (alg === 'HS256' && key.kty !== 'oct') return null;
    return key;
  }

  get size(): number {
    return this.keys.size;
  }

  get lastLoadedAt(): number {
    return this.jwksFetchedAt;
  }

  has(kid: string): boolean {
    return this.keys.has(kid);
  }
}

export interface VerifyTokenOptions {
  keyStore: KillSwitchKeyStore;
  /** Required audience. */
  audience: string;
  /** Unix seconds. Required — the caller owns the clock so tests can travel in time. */
  now: number;
  /** Accepted issuers; omit only in local development. */
  issuers?: readonly string[];
  /** Highest epoch already verified. Rejects replays of older RUNNING states. */
  previousEpoch?: number;
  expectedSubject?: string;
  expectedAgent?: string;
  maxClockSkewSeconds?: number;
  subtle?: SubtleLike;
}

async function verifySignature(
  alg: string,
  key: VerificationKey,
  message: Uint8Array,
  signature: Uint8Array,
  subtle: SubtleLike,
): Promise<boolean> {
  try {
    if (alg === 'EdDSA') {
      if (key.kty !== 'OKP' || key.crv !== 'Ed25519') return false;
      const raw = b64uToBytes(key.x, { maxLength: 64 });
      if (raw.length !== 32) return false;
      const cryptoKey = await subtle.importKey(
        'raw',
        raw as unknown as BufferSource,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      return await subtle.verify(
        { name: 'Ed25519' },
        cryptoKey,
        signature as unknown as BufferSource,
        message as unknown as BufferSource,
      );
    }
    if (alg === 'HS256') {
      if (key.kty !== 'oct') return false;
      const secret = b64uToBytes(key.k, { maxLength: 512 });
      if (secret.length < 32) return false;
      const cryptoKey = await subtle.importKey(
        'raw',
        secret as unknown as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      return await subtle.verify(
        { name: 'HMAC' },
        cryptoKey,
        signature as unknown as BufferSource,
        message as unknown as BufferSource,
      );
    }
    return false;
  } catch {
    // An unusable key is a failed verification, never an exception the caller might swallow.
    return false;
  }
}

/**
 * Verify a signed state token. Resolves to a discriminated result; never throws for a bad token —
 * callers decide policy (the manager turns `ok: false` into a fail-closed refusal).
 */
export async function verifyKillSwitchToken(token: string, options: VerifyTokenOptions): Promise<VerifyResult> {
  const subtle = options.subtle ?? resolveSubtle();
  const split = splitCompactJws(token);
  if (split === null) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'malformed compact JWS' };
  }

  const header = decodeProtectedHeader(split.header);
  if (header === null) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'unparseable protected header' };
  }
  if (typeof header.alg !== 'string' || !options.keyStore.allowsAlgorithm(header.alg)) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: `algorithm not allowed: ${String(header.alg)}` };
  }
  if (header.typ !== KILL_SWITCH_TOKEN_TYP) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'unexpected token type' };
  }
  if (header.v !== KILL_SWITCH_TOKEN_VERSION) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'unsupported token version' };
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > CLAIM_BOUNDS.jti) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'missing key id' };
  }

  const key = options.keyStore.resolve(header.kid, header.alg);
  if (key === null) {
    // An unknown kid is fatal, and the caller is expected to refresh the JWKS once and retry.
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: `no trusted key for kid ${header.kid}` };
  }

  let signature: Uint8Array;
  try {
    signature = b64uToBytes(split.signature, { maxLength: 512 });
  } catch {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'undecodable signature' };
  }

  const verified = await verifySignature(
    header.alg,
    key,
    utf8Encode(`${split.header}.${split.payload}`),
    signature,
    subtle,
  );
  if (!verified) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'signature verification failed' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder('utf-8').decode(b64uToBytes(split.payload, { maxLength: CLAIM_BOUNDS.maxSectionBytes })),
    );
  } catch {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'undecodable payload' };
  }

  const claims = parseKillSwitchClaims(payload);
  if (claims === null) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'claim set failed structural validation' };
  }

  const verifyOptions: VerifyOptions = {
    audience: options.audience,
    now: options.now,
    maxClockSkewSeconds: options.maxClockSkewSeconds ?? KILL_SWITCH_LIMITS.maxClockSkewSeconds,
  };
  if (options.issuers !== undefined) verifyOptions.issuers = options.issuers;
  if (options.previousEpoch !== undefined) verifyOptions.previousEpoch = options.previousEpoch;
  if (options.expectedSubject !== undefined) verifyOptions.expectedSubject = options.expectedSubject;
  if (options.expectedAgent !== undefined) verifyOptions.expectedAgent = options.expectedAgent;

  // Same claim rules as the server, from the same compiled function.
  return validateClaimSet(claims, verifyOptions);
}

/** Byte bounds a JWKS fetch must respect, so a hostile endpoint cannot stream unbounded data. */
export const JWKS_LIMITS = {
  maxBytes: 32 * 1024,
  timeoutMs: 5000,
  minRefreshIntervalSeconds: 30,
} as const;

/**
 * Fetch and parse a JWKS document with hard bounds. Returns `null` on any failure: a refresh
 * failure is not fatal, because the previously loaded keys stay valid (key rotation overlaps).
 */
export async function fetchJwks(
  url: string,
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<JwksDocument | null> {
  const timeoutMs = options.timeoutMs ?? JWKS_LIMITS.timeoutMs;
  const maxBytes = options.maxBytes ?? JWKS_LIMITS.maxBytes;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > maxBytes) return null;
    const parsed = JSON.parse(text) as JwksDocument;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.keys)) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type { KillSwitchClaims, VerifyResult };
