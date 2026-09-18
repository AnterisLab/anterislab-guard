/**
 * AnterisLab Kill Switch — shared contract types.
 *
 * This module is the single source of truth for the wire contract. It is imported unchanged by
 * the server, by the client SDK and by the test-suite, so there is no possibility of the two
 * sides drifting apart (the drift between docs and implementation is exactly what made the
 * 0.1.1 `verdict`/`decision` mismatch silent — this contract is compiled, not prose).
 */

/** Coarse state carried by a signed kill-switch token. */
export type KillSwitchState = 'RUNNING' | 'HALTED';

/** How far the state propagates. `{}` = global, `{tenant}` = tenant-wide, `{tenant,agent}` = one agent. */
export interface KillSwitchScope {
  tenant?: string;
  agent?: string;
}

/**
 * The signed claim set. Every field is a string, an integer or a nested object of the two, so the
 * canonical serialisation is byte-stable and independent implementations can re-derive it.
 */
export interface KillSwitchClaims {
  /** Issuer — the control plane that minted the token. */
  iss: string;
  /** Audience — clients must be configured with the matching value. */
  aud: string;
  /** Subject — the tenant the token applies to. */
  sub: string;
  /** Issued at (unix seconds). */
  iat: number;
  /** Not before (unix seconds). */
  nbf: number;
  /** Expiry (unix seconds). Short-lived by design; absence is a verification failure. */
  exp: number;
  /** Unique token id — ties the token to one audit record. */
  jti: string;
  /** Monotonic counter per subject. Never allowed to move backwards. */
  epoch: number;
  /** The state this token asserts. */
  state: KillSwitchState;
  /** Propagation scope of the state. */
  scope: KillSwitchScope;
  /** Machine-readable reason code (bounded length). */
  reason: string;
  /** Who caused the transition (human identity or service account). */
  actor: string;
  /** Change-management reference (ticket / incident id). */
  evidence: string;
  /** Optional reference to the policy that triggered the transition. */
  policy?: string;
}

/** What the API returns for the state endpoints: the token plus its decoded claims for readability. */
export interface SignedKillSwitchState {
  /** Compact JWS. This is the only part clients are allowed to trust. */
  token: string;
  /** Decoded claims, provided for humans/logs. Clients MUST NOT act on these without verifying `token`. */
  claims: KillSwitchClaims;
  /** Server time when the response was produced (unix seconds) — lets clients spot clock skew. */
  server_time: number;
}

export type KillSwitchErrorCode =
  | 'KILL_SWITCH_STATE_UNAVAILABLE'
  | 'KILL_SWITCH_STATE_INVALID'
  | 'KILL_SWITCH_STATE_STALE'
  | 'KILL_SWITCH_STATE_ROLLBACK'
  | 'KILL_SWITCH_HALTED'
  | 'KILL_SWITCH_UNKNOWN_SCOPE'
  | 'KILL_SWITCH_LOCAL_HALT';

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

/** Actions that must land in the audit chain. */
export type AuditAction =
  | 'killswitch.halt'
  | 'killswitch.resume'
  | 'killswitch.report'
  | 'killswitch.denied'
  | 'killswitch.state.read'
  | 'killswitch.chain.verify';

/**
 * Actions recorded when a request was received but intentionally NOT applied (idempotent replay,
 * resume of an already-RUNNING scope, a denied attempt). They share the audit chain with real
 * transitions so an investigation can see not only what changed but what was *attempted*.
 */
export type AuditReplayAction =
  | 'killswitch.halt.replayed'
  | 'killswitch.resume.replayed'
  | 'killswitch.report.replayed';

/** The full set of action strings that may appear in a chain link. */
export type AuditActionAny = AuditAction | AuditReplayAction;

/** One link of the tamper-evident audit chain. */
export interface AuditEvent {
  /** Monotonic per-chain sequence number, starting at 1. */
  seq: number;
  /** Unix seconds. */
  ts: number;
  /** Who performed the action. */
  actor: string;
  /** Action identifier. */
  action: AuditActionAny;
  /** Tenant the action applies to. */
  tenant: string;
  /** Agent the action applies to, when scoped to one agent. */
  agent?: string;
  /** Resulting state, when the action changed state. */
  state?: KillSwitchState;
  /** Resulting epoch, when the action changed state. */
  epoch?: number;
  /** Human/machine reason. */
  reason: string;
  /** Change-management reference. */
  evidence: string;
  /** Optional correlation id (request id, case id). */
  correlation_id?: string;
  /** Previous link hash (hex). Genesis link uses 64 zeros. */
  prev_hash: string;
  /** SHA-256 over the canonical event body plus `prev_hash` (hex). */
  hash: string;
  /** Base64url signature over `hash`, present on checkpoint links. */
  sig?: string;
  /** Key id that produced `sig`. */
  kid?: string;
}

/** Signed digest of the chain head — the anchor an external auditor pins out-of-band. */
export interface AuditCheckpoint {
  seq: number;
  hash: string;
  signature: string;
  kid: string;
  issued_at: number;
}

export interface AuditChainVerification {
  valid: boolean;
  /** Number of links verified. */
  length: number;
  /** Sequence number of the first broken link, when `valid` is false. */
  broken_at?: number;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* API payloads                                                        */
/* ------------------------------------------------------------------ */

export interface HaltRequest {
  tenant: string;
  agent?: string;
  reason: string;
  evidence: string;
  /** Optional ISO-8601 instant at which the halt auto-expires; omitted = until explicitly resumed. */
  until?: string;
  /** Admin break-glass flag: overrides a previously issued local halt. */
  break_glass?: boolean;
}

export interface ResumeRequest {
  tenant: string;
  agent?: string;
  reason: string;
  evidence: string;
  /** Client's current epoch — survives a lost-response retry without a spurious 409. */
  expected_epoch?: number;
  /**
   * Operator break-glass: the only way to clear a client-reported local halt. Requires elevated
   * scope and is recorded as such in the audit chain.
   */
  break_glass?: boolean;
}

export interface KillSwitchMutationResponse {
  state: SignedKillSwitchState;
  audit: { seq: number; hash: string };
  /** True when the request was an idempotent replay of an earlier one. */
  replayed: boolean;
}

/** What /api/v1/evaluate falls back to when the SDK sends no kill-switch token. */
export interface EvaluateKillSwitchBlock {
  state: 'HALTED';
  epoch: number;
  reason: string;
  retry: false;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const KILL_SWITCH_TOKEN_TYP = 'anterislab-killswitch+jws';
export const KILL_SWITCH_TOKEN_VERSION = 1;
export const KILL_SWITCH_DEFAULT_AUDIENCE = 'anterislab-guard';
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

/** Hard bounds enforced on inbound claims — a token cannot be padded into a memory/CPU weapon. */
export const CLAIM_BOUNDS = {
  maxTokenBytes: 8192,
  maxSectionBytes: 4096,
  reason: 256,
  actor: 128,
  evidence: 128,
  jti: 64,
  iss: 255,
  aud: 255,
  sub: 128,
  scopeValue: 128,
  policy: 128,
} as const;

/** Protocol-level bounds that clients and servers both enforce. */
export const KILL_SWITCH_LIMITS = {
  /** How long a signed state token may live. Keeps the revocation window short. */
  maxTokenTtlSeconds: 300,
  /** Maximum clock skew tolerated on iat/nbf. */
  maxClockSkewSeconds: 60,
} as const;
