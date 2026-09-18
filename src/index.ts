/**
 * @anterislab/guard - punto di ingresso.
 *
 * Ordine deliberato di ogni azione protetta:
 *   1. GATE KILL SWITCH (stato firmato verificato) - prima della policy, non dopo;
 *   2. valutazione della policy su /api/v1/evaluate;
 *   3. allow-list positiva del verdetto;
 *   4. verifica della firma del verdetto (se configurata);
 *   5. RICONTROLLO del kill switch a stato congelato: un halt arrivato durante il punto 2 ferma
 *      comunque l'azione (anti-TOCTOU).
 *
 * Nessun hook, nessun `catch`, nessun default puo' autorizzare un'azione. Solo un verdetto
 * positivo e riconosciuto lo fa.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  GuardBlockedError,
  GuardConfigError,
  GuardError,
  GuardHaltedError,
  GuardPausedError,
  GuardStateInvalidError,
  GuardUnavailableError,
} from './errors.js';
import {
  KillSwitchConfigError,
  KillSwitchHaltedError,
  KillSwitchStaleError,
  KillSwitchUnavailableError,
} from './killswitch/errors.js';
import { KillSwitchManager, type KillSwitchManagerOptions, type KillSwitchStatus } from './killswitch/client.js';
import { Transport } from './transport.js';
import { isAuthorizing, parseVerdict, type ParsedDecision } from './verdict.js';

export const SDK_VERSION = '0.2.0';

/** Host ammessi per default: la chiave non viaggia mai verso un host arbitrario. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['www.anterislab.com', 'anterislab.com'];
export const DEFAULT_BASE_URL = 'https://www.anterislab.com';

export interface GuardOptions {
  /** Chiave API dell'agente. Obbligatoria. Non compare mai in URL, corpo o errori. */
  apiKey: string;
  /** Origine del control plane. Deve essere in `allowedHosts`. Default https://www.anterislab.com */
  baseUrl?: string;
  /** Host verso cui la chiave puo' viaggiare. Default anterislab.com + www.anterislab.com */
  allowedHosts?: readonly string[];
  /** Consente http:// SOLO su loopback, per lo sviluppo locale. Default false. */
  allowInsecureHttp?: boolean;
  /** Timeout dell'intera transazione, lettura del corpo inclusa. Default 5000 ms. */
  timeoutMs?: number;
  /** Retry su guasti di trasporto e 5xx. Mai su 401/402/403/409. Default 1. */
  retries?: number;
  /** Attesa massima onorata da un Retry-After. Oltre: rifiuto. Default 30000 ms. */
  maxRetryAfterMs?: number;
  /** Su guard irraggiungibile prosegue e registra UNAVAILABLE, mai APPROVED. Default false. */
  failOpen?: boolean;
  /** Segreto condiviso HMAC, oppure un verificatore tuo `(body, signature) => boolean`. */
  verifyVerdict?: string | ((rawBody: string, signature: string | null) => boolean);
  /** Header della firma. Default x-anterislab-signature; accetta sha256=<hex> e <hex>. */
  signatureHeader?: string;
  /** Invia un Idempotency-Key per azione, riusato su ogni retry. Default true. */
  idempotency?: boolean;
  /** Vincola questo client a una sola identita' agente. Un disallineamento viene rifiutato. */
  expectedAgent?: string;
  /** Invocato su OGNI verdetto usato. Se solleva, l'esito non cambia. */
  onDecision?: (decision: ParsedDecision, action: Record<string, unknown>) => void;
  /** Solo notifica. Non autorizza MAI l'esecuzione. */
  onPaused?: (decision: ParsedDecision, action: Record<string, unknown>) => void | Promise<void>;
  /** Abilita il gate del kill switch. Senza questo blocco il gate e' assente. */
  killSwitch?: KillSwitchManagerOptions;
  fetchImpl?: typeof fetch;
}

export interface WrapOptions {
  /** Identita' agente valutata dal control plane. */
  agent: string;
  /** Nomi di metodo che NON devono essere valutati (es. describe). Espliciti, uno per uno. */
  passthrough?: readonly string[];
}

export interface WrapFnOptions<A extends unknown[]> {
  agent: string;
  /** Converte gli argomenti nell'azione da valutare. */
  toAction: (...args: A) => Record<string, unknown>;
}

interface ResolvedOptions {
  apiKey: string;
  baseUrl: string;
  allowedHosts: readonly string[];
  timeoutMs: number;
  retries: number;
  maxRetryAfterMs: number;
  failOpen: boolean;
  idempotency: boolean;
  signatureHeader: string;
}

/** Serializzazione deterministica minima (chiavi ordinate) per l'impronta dell'azione. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((entry) => stableStringify(entry)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v));
  return '{' + entries.join(',') + '}';
}

/** Digest SHA-256: e' l'unica cosa che esce dagli argomenti dell'agente. */
export function actionDigest(action: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(action)).digest('hex');
}

function newIdempotencyKey(): string {
  const globalCrypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  const bytes = createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex');
  return bytes.slice(0, 8) + '-' + bytes.slice(8, 12) + '-4' + bytes.slice(13, 16) + '-a' + bytes.slice(17, 20) + '-' + bytes.slice(20, 32);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export class Guard {
  private readonly options: ResolvedOptions;
  private readonly transport: Transport;
  private readonly killSwitch: KillSwitchManager | null;
  private readonly onDecision?: (decision: ParsedDecision, action: Record<string, unknown>) => void;
  private readonly onPaused?: (decision: ParsedDecision, action: Record<string, unknown>) => void | Promise<void>;
  private readonly expectedAgent: string | null;
  private readonly verify: ((rawBody: string, signature: string | null) => boolean) | null;

  constructor(options: GuardOptions) {
    if (!options?.apiKey || options.apiKey.trim().length === 0) {
      throw new GuardConfigError('apiKey e\' obbligatoria');
    }

    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new GuardConfigError('baseUrl non e\' un URL valido: ' + baseUrl);
    }

    if (parsed.protocol !== 'https:') {
      const permittedLoopback = options.allowInsecureHttp === true && isLoopbackHost(parsed.hostname);
      if (!permittedLoopback) {
        throw new GuardConfigError(
          'baseUrl deve usare https (ricevuto ' + parsed.protocol + '//' + parsed.hostname + '). ' +
            'La chiave API viaggerebbe in chiaro. Per lo sviluppo locale usa allowInsecureHttp: true su loopback.',
        );
      }
    }
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new GuardConfigError(
        'host "' + parsed.hostname + '" non e\' in allowedHosts [' + allowedHosts.join(', ') + ']: la chiave non viene inviata a un host non previsto',
      );
    }
    if (options.expectedAgent !== undefined && options.expectedAgent.trim().length === 0) {
      throw new GuardConfigError('expectedAgent se fornito deve essere non vuoto');
    }

    this.options = {
      apiKey: options.apiKey,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      allowedHosts,
      timeoutMs: options.timeoutMs ?? 5000,
      retries: options.retries ?? 1,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 30_000,
      failOpen: options.failOpen === true,
      idempotency: options.idempotency !== false,
      signatureHeader: options.signatureHeader ?? 'x-anterislab-signature',
    };

    this.transport = new Transport({
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      timeoutMs: this.options.timeoutMs,
      retries: this.options.retries,
      maxRetryAfterMs: this.options.maxRetryAfterMs,
      idempotency: this.options.idempotency,
      sdkVersion: SDK_VERSION,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    this.expectedAgent = options.expectedAgent ?? null;
    if (options.onDecision) this.onDecision = options.onDecision;
    if (options.onPaused) this.onPaused = options.onPaused;

    if (typeof options.verifyVerdict === 'string') {
      const secret = options.verifyVerdict;
      if (secret.length < 16) throw new GuardConfigError('il segreto di verifica deve avere almeno 16 caratteri');
      this.verify = (rawBody, signature) => this.verifyHmac(secret, rawBody, signature);
    } else if (typeof options.verifyVerdict === 'function') {
      this.verify = options.verifyVerdict;
    } else {
      this.verify = null;
    }

    if (options.killSwitch) {
      try {
        this.killSwitch = new KillSwitchManager(options.killSwitch);
      } catch (error) {
        if (error instanceof KillSwitchConfigError) throw new GuardConfigError(error.message);
        throw error;
      }
    } else {
      this.killSwitch = null;
    }
  }

  /**
   * Avvolge un oggetto: OGNI metodo proprio ed ereditato passa dal gate prima di eseguire.
   * La 0.1.1 proteggeva un solo metodo; qui la copertura e' il default, e le eccezioni vanno
   * dichiarate una per una in `passthrough`.
   */
  wrap<T extends object>(target: T, options: WrapOptions): T {
    const passthrough = new Set(options.passthrough ?? []);
    const cache = new Map<PropertyKey, unknown>();
    const guard = this;

    return new Proxy(target, {
      get(obj, prop, receiver) {
        const original = Reflect.get(obj, prop, receiver) as unknown;
        if (typeof original !== 'function') return original;
        if (typeof prop === 'symbol') return original;
        if (passthrough.has(prop)) return original.bind(obj);
        if (cache.has(prop)) return cache.get(prop);

        const wrapped = async (...args: unknown[]): Promise<unknown> => {
          const action: Record<string, unknown> = {
            type: String(prop),
            target: typeof obj.constructor?.name === 'string' ? obj.constructor.name : 'object',
            metadata: { args_digest: actionDigest({ args: args as unknown[] }) },
          };
          await guard.decide(action, options.agent);
          // Il metodo viene invocato DOPO il gate: se il gate solleva, l'effetto non accade.
          return await (original as (...a: unknown[]) => unknown).apply(obj, args);
        };
        cache.set(prop, wrapped);
        return wrapped;
      },
    });
  }

  /** Avvolge una singola funzione asincrona (side effect isolato). */
  wrapFn<A extends unknown[], R>(
    fn: (...args: A) => Promise<R> | R,
    options: WrapFnOptions<A>,
  ): (...args: A) => Promise<R> {
    const guard = this;
    return async (...args: A): Promise<R> => {
      await guard.decide(options.toAction(...args), options.agent);
      return await fn(...args);
    };
  }

  /** Ferma l'agente ORA, senza round-trip di rete e senza attendere il control plane. */
  async halt(reason: string, evidence?: string): Promise<KillSwitchStatus> {
    return this.requireKillSwitch().haltLocal(reason, evidence ?? 'LOCAL-OPERATOR');
  }

  /** Riabilita l'agente. Richiede uno stato verificato piu' recente del halt (o break-glass). */
  async resume(options: { reason: string; evidence?: string; breakGlass?: boolean }): Promise<KillSwitchStatus> {
    return this.requireKillSwitch().resumeLocal({
      reason: options.reason,
      ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
      ...(options.breakGlass !== undefined ? { breakGlass: options.breakGlass } : {}),
    });
  }

  /** Stato corrente del kill switch (verificato). */
  async status(): Promise<KillSwitchStatus> {
    return this.requireKillSwitch().checkStatus();
  }

  /** Apre il canale SSE: un halt arriva in pochi millisecondi invece che al prossimo poll. */
  async startStream(): Promise<() => void> {
    return this.requireKillSwitch().startStream();
  }

  /**
   * Valuta un'azione e decide. Questo e' l'unico punto in cui una decisione viene presa.
   * Restituisce la decisione quando l'azione puo' partire; altrimenti solleva.
   */
  async decide(action: Record<string, unknown>, agent: string): Promise<ParsedDecision> {
    this.assertAgent(agent);

    // 1. Il kill switch si valuta PRIMA della policy: un agente fermo non interroga nemmeno il
    //    motore di policy, e soprattutto non consuma quota del piano.
    await this.gateKillSwitch();

    const idempotencyKey = this.options.idempotency ? newIdempotencyKey() : null;
    let outcome;
    try {
      outcome = await this.transport.evaluate({ agent, action }, idempotencyKey);
    } catch (error) {
      if (error instanceof GuardError) {
        if (error instanceof GuardUnavailableError && this.options.failOpen) {
          const failOpenDecision: ParsedDecision = {
            decision: 'APPROVED',
            reason: 'fail-open esplicito: ' + error.message,
            policy: null,
            decisionId: null,
            latencyMs: null,
            agent,
          };
          this.emitDecision(failOpenDecision, action);
          return failOpenDecision;
        }
        throw error;
      }
      throw new GuardUnavailableError('valutazione non riuscita: ' + (error as Error).message);
    }

    // 2. Allow-list positiva. Un corpo non interpretabile e' un diniego, non un'eccezione.
    const parsed = parseVerdict(outcome.body, this.expectedAgent);
    if (!parsed.ok) {
      throw new GuardBlockedError(parsed.detail + ' (' + parsed.code + ')', null, null);
    }
    const decision = parsed.decision;

    // 3. Firma del verdetto: se configurata, una firma assente o invalida e' un diniego.
    if (this.verify) {
      const signature = outcome.headers.get(this.options.signatureHeader);
      const valid = this.verify(outcome.rawBody, signature);
      if (!valid) {
        throw new GuardBlockedError(
          'verdetto non firmato o con firma non valida: rifiutato perche non autentico',
          decision.policy,
          decision.decisionId,
        );
      }
    }

    this.emitDecision(decision, action);

    if (decision.decision === 'PAUSED') {
      // L'hook e' una NOTIFICA. Se risolve, se rigetta o se solleva, l'azione non parte.
      try {
        await this.onPaused?.(decision, action);
      } catch {
        // deliberatamente ingoiato: un hook che fallisce non deve diventare un'autorizzazione
      }
      throw new GuardPausedError(decision.reason, decision.decisionId);
    }

    if (!isAuthorizing(decision.decision)) {
      throw new GuardBlockedError(decision.reason, decision.policy, decision.decisionId);
    }

    // 4. Ricontrollo del gate a stato congelato: nessun round-trip, ma un halt avvenuto durante la
    //    valutazione ferma comunque l'azione (finestra anti-TOCTOU).
    await this.gateKillSwitch({ refresh: false });

    return decision;
  }

  /**
   * Telemetria best-effort per contratto. Un consumatore che solleva non deve MAI cambiare una
   * decisione di sicurezza, ne' in un verso ne' nell'altro. L'ho scoperto scrivendo il test:
   * la prima versione chiamava `this.onDecision?.()` direttamente e un hook che sollevava
   * trasformava un normale BLOCKED in un'eccezione di trasporto (illeggibile per chi la riceve).
   */
  private emitDecision(decision: ParsedDecision, action: Record<string, unknown>): void {
    try {
      this.onDecision?.(decision, action);
    } catch {
      // deliberatamente ingoiato: la telemetria non decide nulla
    }
  }

  private assertAgent(agent: string): void {
    if (!agent || agent.trim().length === 0) throw new GuardConfigError('il nome dell agente e\' obbligatorio');
    if (this.expectedAgent && agent !== this.expectedAgent) {
      throw new GuardBlockedError(
        'questo client e\' vincolato all agente "' + this.expectedAgent + '" ma e\' stata richiesta l\'azione per "' + agent + '"',
        null,
        null,
      );
    }
  }

  private async gateKillSwitch(options: { refresh?: boolean } = {}): Promise<void> {
    if (!this.killSwitch) return;
    try {
      await this.killSwitch.enforce(options.refresh === false ? { refresh: false } : {});
    } catch (error) {
      if (error instanceof KillSwitchHaltedError) {
        const origin: 'control-plane' | 'local' | 'fail-closed' =
          error.details.origin === 'local' ? 'local' : 'control-plane';
        throw new GuardHaltedError(error.details.reason, origin, error.details.epoch);
      }
      if (error instanceof KillSwitchStaleError) {
        throw new GuardStateInvalidError('stato del kill switch troppo vecchio: ' + error.message);
      }
      if (error instanceof KillSwitchUnavailableError) {
        throw new GuardUnavailableError(error.message);
      }
      throw error;
    }
  }

  private requireKillSwitch(): KillSwitchManager {
    if (!this.killSwitch) {
      throw new GuardConfigError(
        'il kill switch non e\' configurato su questo Guard: passa killSwitch: { tenant, agent } al costruttore',
      );
    }
    return this.killSwitch;
  }

  private verifyHmac(secret: string, rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

export {
  GuardBlockedError,
  GuardConfigError,
  GuardError,
  GuardHaltedError,
  GuardPausedError,
  GuardPolicyError,
  GuardQuotaError,
  GuardStateInvalidError,
  GuardUnavailableError,
  GuardAuthError,
} from './errors.js';
export {
  KillSwitchError,
  KillSwitchHaltedError,
  KillSwitchUnavailableError,
  KillSwitchStaleError,
  KillSwitchRollbackError,
  KillSwitchStateInvalidError,
  KillSwitchLocalHaltError,
} from './killswitch/errors.js';
export { KillSwitchManager } from './killswitch/client.js';
export type { KillSwitchManagerOptions, KillSwitchStatus, KillSwitchClientEvent } from './killswitch/client.js';
export { parseVerdict, canonicalizeVerdict, isAuthorizing } from './verdict.js';
export type { CanonicalVerdict, ParsedDecision } from './verdict.js';
export type { GuardAction } from './types.js';
