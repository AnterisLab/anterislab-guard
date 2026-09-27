/**
 * SDK error hierarchy.
 *
 * Design rule: NO error in this hierarchy authorizes an action.
 * All derive from `GuardError`, so a `catch (e) { if (e instanceof GuardError) ... }`
 * catches any reason the guard stopped the agent.
 */

/** Common root: if you catch this, you have caught every reason for a stop. */
export class GuardError extends Error {
  /** Stable code, meant for logs and metrics (never for control flow). */
  readonly code: string;
  /** true when the action was NOT executed. Always true except in documented cases. */
  readonly blocked: boolean;

  constructor(code: string, message: string, blocked = true) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.blocked = blocked;
  }
}

/** The policy denied the action (BLOCKED verdict, or any unrecognized response). */
export class GuardBlockedError extends GuardError {
  readonly policy: string | null;
  readonly decisionId: string | null;
  readonly reason: string;

  constructor(reason: string, policy: string | null, decisionId: string | null = null) {
    super('GUARD_BLOCKED', `action BLOCKED by policy: ${reason}`, true);
    this.name = 'GuardBlockedError';
    this.reason = reason;
    this.policy = policy;
    this.decisionId = decisionId;
  }
}

/** The verdict is PAUSED: the action remains suspended pending human review. */
export class GuardPausedError extends GuardError {
  readonly decisionId: string | null;
  readonly reason: string;

  constructor(reason: string, decisionId: string | null = null) {
    super('GUARD_PAUSED', `action PAUSED for human review: ${reason}`, true);
    this.name = 'GuardPausedError';
    this.reason = reason;
    this.decisionId = decisionId;
  }
}

/** 401/403: invalid, revoked key, or agent out of scope. Terminal: never retried. */
export class GuardAuthError extends GuardError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(status === 401 ? 'GUARD_UNAUTHORIZED' : 'GUARD_FORBIDDEN', message, true);
    this.name = 'GuardAuthError';
    this.status = status;
  }
}

/** 402: plan quota exhausted. Terminal, never retried, NEVER fail-open. */
export class GuardQuotaError extends GuardError {
  readonly plan: string | null;
  readonly limit: number | null;
  readonly used: number | null;

  constructor(plan: string | null, limit: number | null, used: number | null) {
    super(
      'GUARD_QUOTA_EXCEEDED',
      `plan quota exhausted (plan=${plan ?? '?'} used=${used ?? '?'} limit=${limit ?? '?'})`,
      true,
    );
    this.name = 'GuardQuotaError';
    this.plan = plan;
    this.limit = limit;
    this.used = used;
  }
}

/** 409: stale policy snapshot. Terminal: realign the etag and retry with a new key. */
export class GuardPolicyError extends GuardError {
  readonly expected: string | null;
  readonly received: string | null;

  constructor(message: string, expected: string | null = null, received: string | null = null) {
    super('GUARD_STALE_POLICY', message, true);
    this.name = 'GuardPolicyError';
    this.expected = expected;
    this.received = received;
  }
}

/** Guard unreachable (timeout, network, 5xx after the budget): fail-closed by default. */
export class GuardUnavailableError extends GuardError {
  /** true when the caller chose `failOpen: true` and decided to proceed anyway. */
  readonly failOpenApplied: boolean;

  constructor(message: string, failOpenApplied = false) {
    super('GUARD_UNAVAILABLE', message, !failOpenApplied);
    this.name = 'GuardUnavailableError';
    this.failOpenApplied = failOpenApplied;
  }
}

/** The kill switch stopped the agent (control plane or local halt). */
export class GuardHaltedError extends GuardError {
  readonly origin: 'control-plane' | 'local' | 'fail-closed';
  readonly epoch: number | null;

  constructor(message: string, origin: 'control-plane' | 'local' | 'fail-closed', epoch: number | null = null) {
    super('GUARD_HALTED', message, true);
    this.name = 'GuardHaltedError';
    this.origin = origin;
    this.epoch = epoch;
  }
}

/** Invalid configuration (host not allowed, non-loopback http://, inconsistent options). */
export class GuardConfigError extends GuardError {
  constructor(message: string) {
    super('GUARD_CONFIG', message, true);
    this.name = 'GuardConfigError';
  }
}

/** Kill switch state not verifiable: expired token, invalid signature, regressive epoch. */
export class GuardStateInvalidError extends GuardError {
  constructor(message: string) {
    super('GUARD_STATE_INVALID', message, true);
    this.name = 'GuardStateInvalidError';
  }
}
