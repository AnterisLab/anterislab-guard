/**
 * Re-exports of the package's public symbols, so tests exercise the *published* API (dist/)
 * rather than the sources.
 */
export {
  Guard,
  GuardBlockedError,
  GuardPausedError,
  GuardQuotaError,
  GuardUnavailableError,
  GuardAuthError,
  GuardPolicyError,
  GuardHaltedError,
  GuardConfigError,
  GuardStateInvalidError,
  KillSwitchManager,
  KillSwitchError,
  KillSwitchHaltedError,
  KillSwitchUnavailableError,
  KillSwitchStaleError,
  KillSwitchRollbackError,
  KillSwitchStateInvalidError,
  KillSwitchLocalHaltError,
  parseVerdict,
  canonicalizeVerdict,
  isAuthorizing,
  actionDigest,
  SDK_VERSION,
} from '../dist/index.js';
