/**
 * Gerarchia degli errori del SDK.
 *
 * Regola di design: NESSUN errore di questa gerarchia autorizza un'azione.
 * Tutti derivano da `GuardError`, quindi un `catch (e) { if (e instanceof GuardError) ... }`
 * intercetta qualsiasi motivo per cui il guard ha fermato l'agente.
 */

/** Radice comune: se catturi questo, hai catturato ogni motivo di arresto. */
export class GuardError extends Error {
  /** Codice stabile, pensato per log e metriche (mai per il controllo di flusso). */
  readonly code: string;
  /** true quando l'azione NON e' stata eseguita. Sempre true tranne nei casi documentati. */
  readonly blocked: boolean;

  constructor(code: string, message: string, blocked = true) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.blocked = blocked;
  }
}

/** La policy ha negato l'azione (verdetto BLOCKED, o qualunque risposta non riconosciuta). */
export class GuardBlockedError extends GuardError {
  readonly policy: string | null;
  readonly decisionId: string | null;
  readonly reason: string;

  constructor(reason: string, policy: string | null, decisionId: string | null = null) {
    super('GUARD_BLOCKED', `azione BLOCCATA dalla policy: ${reason}`, true);
    this.name = 'GuardBlockedError';
    this.reason = reason;
    this.policy = policy;
    this.decisionId = decisionId;
  }
}

/** Il verdetto e' PAUSED: l'azione resta sospesa in attesa di revisione umana. */
export class GuardPausedError extends GuardError {
  readonly decisionId: string | null;
  readonly reason: string;

  constructor(reason: string, decisionId: string | null = null) {
    super('GUARD_PAUSED', `azione SOSPESA per revisione umana: ${reason}`, true);
    this.name = 'GuardPausedError';
    this.reason = reason;
    this.decisionId = decisionId;
  }
}

/** 401/403: chiave non valida, revocata, o agente fuori scope. Terminale: mai ritentato. */
export class GuardAuthError extends GuardError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(status === 401 ? 'GUARD_UNAUTHORIZED' : 'GUARD_FORBIDDEN', message, true);
    this.name = 'GuardAuthError';
    this.status = status;
  }
}

/** 402: quota del piano esaurita. Terminale, mai ritentato, MAI fail-open. */
export class GuardQuotaError extends GuardError {
  readonly plan: string | null;
  readonly limit: number | null;
  readonly used: number | null;

  constructor(plan: string | null, limit: number | null, used: number | null) {
    super(
      'GUARD_QUOTA_EXCEEDED',
      `quota del piano esaurita (piano=${plan ?? '?'} usati=${used ?? '?'} limite=${limit ?? '?'})`,
      true,
    );
    this.name = 'GuardQuotaError';
    this.plan = plan;
    this.limit = limit;
    this.used = used;
  }
}

/** 409: snapshot di policy stantio. Terminale: riallinea l'etag e ripeti con una nuova chiave. */
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

/** Guard irraggiungibile (timeout, rete, 5xx dopo il budget): fail-closed per default. */
export class GuardUnavailableError extends GuardError {
  /** true quando il chiamante ha scelto `failOpen: true` e ha deciso di procedere comunque. */
  readonly failOpenApplied: boolean;

  constructor(message: string, failOpenApplied = false) {
    super('GUARD_UNAVAILABLE', message, !failOpenApplied);
    this.name = 'GuardUnavailableError';
    this.failOpenApplied = failOpenApplied;
  }
}

/** Il kill switch ha fermato l'agente (control plane oppure halt locale). */
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

/** Configurazione non valida (host non ammesso, http:// non-loopback, opzioni incoerenti). */
export class GuardConfigError extends GuardError {
  constructor(message: string) {
    super('GUARD_CONFIG', message, true);
    this.name = 'GuardConfigError';
  }
}

/** Stato del kill switch non verificabile: token scaduto, firma invalida, epoch regressivo. */
export class GuardStateInvalidError extends GuardError {
  constructor(message: string) {
    super('GUARD_STATE_INVALID', message, true);
    this.name = 'GuardStateInvalidError';
  }
}
