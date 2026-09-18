/**
 * AnterisLab Guard — kill-switch client errors.
 *
 * Every error carries a stable `code` so calling code branches on a value, never on a message
 * string. `failClosed` is explicit on each one: it is the property auditors ask about, and making
 * it a field forces it to be a deliberate decision rather than an emergent behaviour.
 */

import type { KillSwitchErrorCode, KillSwitchState } from '../shared/killswitch-types.js';

export interface KillSwitchErrorDetails {
  /** Why the kill switch blocked the action. */
  reason: string;
  /** Epoch the client had verified at the moment of blocking. */
  epoch: number;
  /** Whether the halt came from the control plane or from the client itself. */
  origin: 'control-plane' | 'local';
  /** Whether the token was cryptographically verified (never trust an unverified halt… except to obey it). */
  verified: boolean;
  /** Agent the halt applies to. */
  agent: string;
  /** Tenant the halt applies to. */
  tenant: string;
  /** Unix seconds. */
  at: number;
}

export class KillSwitchError extends Error {
  readonly code: KillSwitchErrorCode;
  readonly failClosed = true;
  constructor(code: KillSwitchErrorCode, message: string) {
    super(message);
    this.name = 'KillSwitchError';
    this.code = code;
  }
}

/**
 * Thrown when an action is refused because the kill switch is engaged. This error means the guard
 * worked: the side effect did NOT happen.
 */
export class KillSwitchHaltedError extends KillSwitchError {
  readonly details: KillSwitchErrorDetails;
  constructor(details: KillSwitchErrorDetails) {
    super(
      'KILL_SWITCH_HALTED',
      `[AnterisLab] action refused: kill switch is HALTED for agent "${details.agent}" ` +
        `(${details.origin}, epoch ${details.epoch}) — ${details.reason}`,
    );
    this.name = 'KillSwitchHaltedError';
    this.details = details;
  }
}

/**
 * Thrown when the client cannot establish a trustworthy state. The default posture is to refuse
 * the action: an unreachable control plane is indistinguishable from a control plane that has been
 * taken down *because* something is going wrong.
 */
export class KillSwitchUnavailableError extends KillSwitchError {
  readonly detail: string;
  constructor(detail: string) {
    super(
      'KILL_SWITCH_STATE_UNAVAILABLE',
      `[AnterisLab] action refused: kill-switch state could not be verified (${detail}). ` +
        'Failing closed — the control plane being unreachable is not evidence that it is safe to proceed.',
    );
    this.name = 'KillSwitchUnavailableError';
    this.detail = detail;
  }
}

/** Thrown when the newest verified state is older than the configured freshness bound. */
export class KillSwitchStaleError extends KillSwitchError {
  readonly ageSeconds: number;
  readonly maxAgeSeconds: number;
  constructor(ageSeconds: number, maxAgeSeconds: number) {
    super(
      'KILL_SWITCH_STATE_STALE',
      `[AnterisLab] action refused: verified kill-switch state is ${ageSeconds}s old ` +
        `(maximum ${maxAgeSeconds}s). Failing closed.`,
    );
    this.name = 'KillSwitchStaleError';
    this.ageSeconds = ageSeconds;
    this.maxAgeSeconds = maxAgeSeconds;
  }
}

/** Thrown when a token claims an epoch lower than one already observed — a replay attempt. */
export class KillSwitchRollbackError extends KillSwitchError {
  readonly presentedEpoch: number;
  readonly knownEpoch: number;
  constructor(presentedEpoch: number, knownEpoch: number) {
    super(
      'KILL_SWITCH_STATE_ROLLBACK',
      `[AnterisLab] refused a state token with epoch ${presentedEpoch} after having verified epoch ${knownEpoch}. ` +
        'A state that moves backwards is a replay, and it is never applied.',
    );
    this.name = 'KillSwitchRollbackError';
    this.presentedEpoch = presentedEpoch;
    this.knownEpoch = knownEpoch;
  }
}

/** A token whose signature, claims or scope could not be trusted. */
export class KillSwitchStateInvalidError extends KillSwitchError {
  constructor(detail: string) {
    super('KILL_SWITCH_STATE_INVALID', `[AnterisLab] kill-switch state rejected: ${detail}`);
    this.name = 'KillSwitchStateInvalidError';
  }
}

/** Raised by `resumeLocal()` when there is no verified RUNNING state to resume on. */
export class KillSwitchLocalHaltError extends KillSwitchError {
  constructor(detail: string) {
    super(
      'KILL_SWITCH_LOCAL_HALT',
      `[AnterisLab] local resume refused: ${detail}. A local halt is cleared only by a verified ` +
        'control-plane state that is newer than the halt (or by break-glass with an explicit reason).',
    );
    this.name = 'KillSwitchLocalHaltError';
  }
}

/** Configuration that would weaken the guarantees is rejected at construction time. */
export class KillSwitchConfigError extends Error {
  constructor(message: string) {
    super(`[AnterisLab] invalid kill-switch configuration: ${message}`);
    this.name = 'KillSwitchConfigError';
  }
}

export function isHalted(state: KillSwitchState | undefined): boolean {
  return state === 'HALTED';
}
