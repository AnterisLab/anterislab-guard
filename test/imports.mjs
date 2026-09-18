/**
 * Riesportazioni dei simboli pubblici del pacchetto, cosi' i test verificano l'API
 * *pubblicata* (dist/) e non i sorgenti.
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
  parseVerdict,
  canonicalizeVerdict,
  isAuthorizing,
  actionDigest,
  SDK_VERSION,
} from '../dist/index.js';
