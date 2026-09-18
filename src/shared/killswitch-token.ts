/**
 * AnterisLab Kill Switch — compact JWS (EdDSA) encode/verify.
 *
 * Portable: no `node:*` import. The cryptographic primitive is injected through the
 * {@link SignatureVerifier} interface, so this logic runs unchanged in Node, in the browser
 * (WebCrypto Ed25519) and in the test-suite (which injects deliberately broken verifiers).
 *
 * Verification is deliberately ordered **verify-then-parse**: we never let unauthenticated
 * payload bytes influence a decision, not even indirectly through an error message.
 */

import { b64uToBytes, bytesToB64u, utf8Decode, utf8Encode } from './base64url.js';
import { canonicalize } from './canonical-json.js';
import {
  CLAIM_BOUNDS,
  KILL_SWITCH_LIMITS,
  KILL_SWITCH_TOKEN_TYP,
  KILL_SWITCH_TOKEN_VERSION,
  type KillSwitchClaims,
  type KillSwitchErrorCode,
  type KillSwitchScope,
  type KillSwitchState,
} from './killswitch-types.js';

/** A verification key: an Ed25519 JWK (`OKP`) or a shared secret for the self-host HS256 mode. */
export type VerificationKey =
  | { kty: 'OKP'; crv: 'Ed25519'; x: string; kid?: string }
  | { kty: 'oct'; k: string; kid?: string };

export interface SignatureVerifier {
  /** Algorithms this verifier is willing to accept. Anything else is rejected outright. */
  readonly supportedAlgorithms: readonly string[];
  /**
   * Verify `signature` over `message` with `key`.
   * MUST return false (never throw) for a bad signature, and MUST reject `key`/`alg` mismatches.
   */
  verify(alg: string, key: VerificationKey, message: Uint8Array, signature: Uint8Array): boolean;
}

export interface VerifyOptions {
  /** Expected audience. Verification fails if the claim differs. */
  audience: string;
  /** Accepted issuer(s). Empty/undefined disables the check (only for local test mode). */
  issuers?: readonly string[];
  /** Current unix seconds. Required — no hidden clock reads inside the verifier. */
  now: number;
  /** Highest epoch seen so far for this subject. A lower epoch is a rollback and fails. */
  previousEpoch?: number;
  /** Maximum tolerated clock skew for iat/nbf. Default {@link KILL_SWITCH_LIMITS.maxClockSkewSeconds}. */
  maxClockSkewSeconds?: number;
  /** Subject (tenant) the caller believes it is; a mismatch fails closed. */
  expectedSubject?: string;
  /** Agent the caller acts as; a token scoped to a different agent fails closed. */
  expectedAgent?: string;
}

export type VerifyResult =
  | { ok: true; claims: KillSwitchClaims; aligned: boolean }
  | { ok: false; code: KillSwitchErrorCode; detail: string };

export function decodeProtectedHeader(section: string): { alg: string; kid?: string; typ?: string; v?: number } | null {
  if (section.length > CLAIM_BOUNDS.maxSectionBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(b64uToBytes(section, { maxLength: CLAIM_BOUNDS.maxSectionBytes })));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as { alg: string; kid?: string; typ?: string; v?: number };
}

/** Split a compact JWS and reject anything whose shape is not exactly three base64url sections. */
export function splitCompactJws(token: string): { header: string; payload: string; signature: string } | null {
  if (typeof token !== 'string') return null;
  if (token.length === 0 || token.length > CLAIM_BOUNDS.maxTokenBytes) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  if (!header || !payload || !signature) return null;
  if (header.length > CLAIM_BOUNDS.maxSectionBytes || payload.length > CLAIM_BOUNDS.maxSectionBytes) return null;
  return { header, payload, signature };
}

export interface EncodeInput {
  claims: KillSwitchClaims;
  alg: 'EdDSA' | 'HS256';
  kid: string;
  /** Signs the signing input and returns the raw signature bytes. */
  sign: (signingInput: Uint8Array, alg: 'EdDSA' | 'HS256', kid: string) => Uint8Array;
}

export function encodeCompactJws(input: EncodeInput): string {
  const header = {
    alg: input.alg,
    kid: input.kid,
    typ: KILL_SWITCH_TOKEN_TYP,
    v: KILL_SWITCH_TOKEN_VERSION,
  };
  const headerSection = bytesToB64u(utf8Encode(canonicalize(header)));
  const payloadSection = bytesToB64u(utf8Encode(canonicalize(input.claims)));
  const signingInput = `${headerSection}.${payloadSection}`;
  const signature = input.sign(utf8Encode(signingInput), input.alg, input.kid);
  return `${signingInput}.${bytesToB64u(signature)}`;
}

function fail(code: KillSwitchErrorCode, detail: string): VerifyResult {
  return { ok: false, code, detail };
}

/** Bounded, single-line string check for claims that end up in logs. */
function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseScope(raw: unknown): KillSwitchScope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (key !== 'tenant' && key !== 'agent') return null;
    if (candidate[key] !== undefined && !boundedString(candidate[key], CLAIM_BOUNDS.scopeValue)) return null;
  }
  const scope: KillSwitchScope = {};
  if (typeof candidate.tenant === 'string') scope.tenant = candidate.tenant;
  if (typeof candidate.agent === 'string') scope.agent = candidate.agent;
  // An agent-scoped token must also carry its tenant, otherwise scope resolution is ambiguous.
  if (scope.agent !== undefined && scope.tenant === undefined) return null;
  return scope;
}

export type ClaimsValidationResult =
  | { ok: true; claims: KillSwitchClaims; aligned: boolean }
  | { ok: false; code: KillSwitchErrorCode; detail: string };

function parseClaims(payload: unknown): KillSwitchClaims | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const c = payload as Record<string, unknown>;

  if (!boundedString(c.iss, CLAIM_BOUNDS.iss)) return null;
  if (!boundedString(c.aud, CLAIM_BOUNDS.aud)) return null;
  if (!boundedString(c.sub, CLAIM_BOUNDS.sub)) return null;
  if (!boundedString(c.jti, CLAIM_BOUNDS.jti)) return null;
  if (!boundedString(c.reason, CLAIM_BOUNDS.reason)) return null;
  if (!boundedString(c.actor, CLAIM_BOUNDS.actor)) return null;
  if (!boundedString(c.evidence, CLAIM_BOUNDS.evidence)) return null;
  if (c.policy !== undefined && !boundedString(c.policy, CLAIM_BOUNDS.policy)) return null;

  const numeric: Array<[string, unknown]> = [
    ['iat', c.iat],
    ['nbf', c.nbf],
    ['exp', c.exp],
    ['epoch', c.epoch],
  ];
  for (const [name, value] of numeric) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    if (name === 'epoch' ? value < 1 : value < 0) return null;
  }

  if (c.state !== 'RUNNING' && c.state !== 'HALTED') return null;
  const scope = parseScope(c.scope);
  if (scope === null) return null;

  const claims: KillSwitchClaims = {
    iss: c.iss as string,
    aud: c.aud as string,
    sub: c.sub as string,
    iat: c.iat as number,
    nbf: c.nbf as number,
    exp: c.exp as number,
    jti: c.jti as string,
    epoch: c.epoch as number,
    state: c.state as KillSwitchState,
    scope,
    reason: c.reason as string,
    actor: c.actor as string,
    evidence: c.evidence as string,
  };
  if (typeof c.policy === 'string') claims.policy = c.policy;
  return claims;
}

/**
 * Resolve a key for `kid`. A `null` return means "no key for this kid" and is always fatal:
 * an unknown kid must never silently degrade to "no signature check".
 */
export type KeyResolver = (kid: string, alg: string) => VerificationKey | null;

/**
 * Stage 5 of the verification pipeline, exported on its own so an independent implementation
 * (e.g. the SDK's async WebCrypto path) reuses the exact same claim rules. Structural parsing is
 * exported too: these two functions are the *only* place a claim shape is accepted, so the server
 * and the client cannot disagree about what a valid state token looks like.
 */
export function parseKillSwitchClaims(payload: unknown): KillSwitchClaims | null {
  return parseClaims(payload);
}

/** Decode a token's claims WITHOUT verifying. Diagnostics only — never a decision input. */
export function decodeClaimsFromToken(token: string): KillSwitchClaims | null {
  const split = splitCompactJws(token);
  if (split === null) return null;
  try {
    return parseClaims(
      JSON.parse(utf8Decode(b64uToBytes(split.payload, { maxLength: CLAIM_BOUNDS.maxSectionBytes }))),
    );
  } catch {
    return null;
  }
}

/** Claim-level validation: audience, issuer, subject, time window, TTL cap, epoch, scope. */
export function validateClaimSet(claims: KillSwitchClaims, options: VerifyOptions): ClaimsValidationResult {
  if (claims.aud !== options.audience) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'audience mismatch' };
  }
  if (options.issuers && options.issuers.length > 0 && !options.issuers.includes(claims.iss)) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'issuer not trusted' };
  }
  if (options.expectedSubject !== undefined && claims.sub !== options.expectedSubject) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'subject mismatch' };
  }

  const skew = options.maxClockSkewSeconds ?? KILL_SWITCH_LIMITS.maxClockSkewSeconds;
  if (claims.exp <= options.now - skew) {
    return { ok: false, code: 'KILL_SWITCH_STATE_STALE', detail: 'token expired' };
  }
  if (claims.nbf > options.now + skew) {
    return { ok: false, code: 'KILL_SWITCH_STATE_STALE', detail: 'token not yet valid' };
  }
  if (claims.iat > options.now + skew) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'issued-at in the future' };
  }
  if (claims.exp - claims.iat > KILL_SWITCH_LIMITS.maxTokenTtlSeconds + skew) {
    return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'token TTL exceeds protocol maximum' };
  }

  // Epoch is per-subject; a rollback means someone is replaying an old (e.g. RUNNING) token.
  if (options.previousEpoch !== undefined && claims.epoch < options.previousEpoch) {
    return {
      ok: false,
      code: 'KILL_SWITCH_STATE_ROLLBACK',
      detail: `epoch ${claims.epoch} < previously seen ${options.previousEpoch}`,
    };
  }

  // Scope must cover the caller. A token issued for another agent never applies here.
  if (claims.scope.agent !== undefined) {
    if (options.expectedAgent === undefined || claims.scope.agent !== options.expectedAgent) {
      return { ok: false, code: 'KILL_SWITCH_STATE_INVALID', detail: 'token does not cover the calling agent' };
    }
  }

  return { ok: true, claims, aligned: claims.state === 'HALTED' };
}

export function verifyCompactJws(
  token: string,
  verifier: SignatureVerifier,
  resolveKey: KeyResolver,
  options: VerifyOptions,
): VerifyResult {
  const split = splitCompactJws(token);
  if (split === null) return fail('KILL_SWITCH_STATE_INVALID', 'malformed compact JWS');

  const header = decodeProtectedHeader(split.header);
  if (header === null) return fail('KILL_SWITCH_STATE_INVALID', 'unparseable protected header');

  // 1. Algorithm allow-list. `none`, `HS256`-as-EdDSA confusion and friends die here.
  if (typeof header.alg !== 'string' || !verifier.supportedAlgorithms.includes(header.alg)) {
    return fail('KILL_SWITCH_STATE_INVALID', `algorithm not allowed: ${String(header.alg)}`);
  }
  if (header.typ !== KILL_SWITCH_TOKEN_TYP) return fail('KILL_SWITCH_STATE_INVALID', 'unexpected token type');
  if (header.v !== KILL_SWITCH_TOKEN_VERSION) return fail('KILL_SWITCH_STATE_INVALID', 'unsupported token version');
  if (!boundedString(header.kid, CLAIM_BOUNDS.jti)) return fail('KILL_SWITCH_STATE_INVALID', 'missing key id');

  // 2. Key resolution happens BEFORE signature checking (we need the key), but the payload is
  //    still untouched: nothing below this point trusts attacker-controlled bytes.
  const key = resolveKey(header.kid, header.alg);
  if (key === null) return fail('KILL_SWITCH_STATE_INVALID', `no trusted key for kid ${header.kid}`);

  // 3. Signature verification over the exact received bytes.
  let signature: Uint8Array;
  try {
    signature = b64uToBytes(split.signature, { maxLength: 512 });
  } catch {
    return fail('KILL_SWITCH_STATE_INVALID', 'undecodable signature');
  }
  const signingInput = utf8Encode(`${split.header}.${split.payload}`);
  let signatureValid: boolean;
  try {
    signatureValid = verifier.verify(header.alg, key, signingInput, signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return fail('KILL_SWITCH_STATE_INVALID', 'signature verification failed');

  // 4. Only now is the payload parsed.
  let payload: unknown;
  try {
    payload = JSON.parse(utf8Decode(b64uToBytes(split.payload, { maxLength: CLAIM_BOUNDS.maxSectionBytes })));
  } catch {
    return fail('KILL_SWITCH_STATE_INVALID', 'undecodable payload');
  }
  const claims = parseClaims(payload);
  if (claims === null) return fail('KILL_SWITCH_STATE_INVALID', 'claim set failed structural validation');

  // 5. Claim validation.
  const validated = validateClaimSet(claims, options);
  if (!validated.ok) return fail(validated.code, validated.detail);
  return validated;
}

export function scopeCovers(scope: KillSwitchScope, tenant: string, agent?: string): boolean {
  if (scope.tenant !== undefined && scope.tenant !== tenant) return false;
  if (scope.agent !== undefined && scope.agent !== agent) return false;
  return true;
}
