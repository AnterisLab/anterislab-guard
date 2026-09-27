/**
 * @anterislab/guard - entry point.
 *
 * Deliberate order of every protected action:
 *   1. KILL SWITCH GATE (verified signed state) - before policy, not after;
 *   2. policy evaluation on /api/v1/evaluate;
 *   3. positive allow-list of the verdict;
 *   4. verdict signature verification (if configured);
 *   5. RE-CHECK of the kill switch against the frozen state: a halt arriving during step 2 still
 *      stops the action (anti-TOCTOU).
 *
 * No hook, no `catch`, no default can authorize an action. Only a positive, recognized verdict
 * does.
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
import { stripTrailingSlashes } from './shared/url.js';

export const SDK_VERSION = '0.2.0';

/** Default allowed hosts: the key never travels to an arbitrary host. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['www.anterislab.com', 'anterislab.com'];
export const DEFAULT_BASE_URL = 'https://www.anterislab.com';

export interface GuardOptions {
  /** Agent API key. Required. Never appears in URLs, bodies, or errors. */
  apiKey: string;
  /** Control plane origin. Must be listed in `allowedHosts`. Default https://www.anterislab.com */
  baseUrl?: string;
  /** Hosts the key is allowed to travel to. Default anterislab.com + www.anterislab.com */
  allowedHosts?: readonly string[];
  /** Allows http:// ONLY on loopback, for local development. Default false. */
  allowInsecureHttp?: boolean;
  /** Timeout for the entire transaction, including body reads. Default 5000 ms. */
  timeoutMs?: number;
  /** Retries on transport failures and 5xx. Never on 401/402/403/409. Default 1. */
  retries?: number;
  /** Maximum delay honored from a Retry-After. Beyond that: reject. Default 30000 ms. */
  maxRetryAfterMs?: number;
  /** On unreachable guard, proceeds and records UNAVAILABLE, never APPROVED. Default false. */
  failOpen?: boolean;
  /** Shared HMAC secret, or a custom verifier `(body, signature) => boolean`. */
  verifyVerdict?: string | ((rawBody: string, signature: string | null) => boolean);
  /** Signature header. Default x-anterislab-signature; accepts sha256=<hex> and <hex>. */
  signatureHeader?: string;
  /** Sends an Idempotency-Key per action, reused across retries. Default true. */
  idempotency?: boolean;
  /** Pins this client to a single agent identity. A mismatch is rejected. */
  expectedAgent?: string;
  /** Called on EVERY verdict used. If it throws, the outcome does not change. */
  onDecision?: (decision: ParsedDecision, action: Record<string, unknown>) => void;
  /** Notification only. NEVER authorizes execution. */
  onPaused?: (decision: ParsedDecision, action: Record<string, unknown>) => void | Promise<void>;
  /** Enables the kill switch gate. Without this block, the gate is absent. */
  killSwitch?: KillSwitchManagerOptions;
  fetchImpl?: typeof fetch;
}

export interface WrapOptions {
  /** Agent identity evaluated by the control plane. */
  agent: string;
  /** Method names that must NOT be evaluated (e.g. describe). Explicit, one by one. */
  passthrough?: readonly string[];
}

export interface WrapFnOptions<A extends unknown[]> {
  agent: string;
  /** Converts the arguments into the action to evaluate. */
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

/** Minimal deterministic serialization (sorted keys) for the action fingerprint. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((entry) => stableStringify(entry)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v));
  return '{' + entries.join(',') + '}';
}

/** SHA-256 digest: it is the only thing that leaves the agent's arguments. */
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
      throw new GuardConfigError('apiKey is required');
    }

    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new GuardConfigError('baseUrl is not a valid URL: ' + baseUrl);
    }

    if (parsed.protocol !== 'https:') {
      const permittedLoopback = options.allowInsecureHttp === true && isLoopbackHost(parsed.hostname);
      if (!permittedLoopback) {
        throw new GuardConfigError(
          'baseUrl must use https (received ' + parsed.protocol + '//' + parsed.hostname + '). ' +
            'The API key would travel in cleartext. For local development use allowInsecureHttp: true on loopback.',
        );
      }
    }
    if (!allowedHosts.includes(parsed.hostname)) {
      throw new GuardConfigError(
        'host "' + parsed.hostname + '" is not in allowedHosts [' + allowedHosts.join(', ') + ']: the key is not sent to an unexpected host',
      );
    }
    if (options.expectedAgent !== undefined && options.expectedAgent.trim().length === 0) {
      throw new GuardConfigError('expectedAgent, when provided, must be non-empty');
    }

    this.options = {
      apiKey: options.apiKey,
      baseUrl: stripTrailingSlashes(baseUrl),
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
      if (secret.length < 16) throw new GuardConfigError('the verification secret must be at least 16 characters long');
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
   * Wraps an object: EVERY own and inherited method goes through the gate before executing.
   * Version 0.1.1 protected only a single method; here, full coverage is the default, and
   * exceptions must be declared one by one in `passthrough`.
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
          // The method is invoked AFTER the gate: if the gate throws, the effect does not happen.
          return await (original as (...a: unknown[]) => unknown).apply(obj, args);
        };
        cache.set(prop, wrapped);
        return wrapped;
      },
    });
  }

  /** Wraps a single async function (isolated side effect). */
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

  /** Stops the agent NOW, without a network round-trip and without waiting for the control plane. */
  async halt(reason: string, evidence?: string): Promise<KillSwitchStatus> {
    return this.requireKillSwitch().haltLocal(reason, evidence ?? 'LOCAL-OPERATOR');
  }

  /** Re-enables the agent. Requires a verified state newer than the halt (or break-glass). */
  async resume(options: { reason: string; evidence?: string; breakGlass?: boolean }): Promise<KillSwitchStatus> {
    return this.requireKillSwitch().resumeLocal({
      reason: options.reason,
      ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
      ...(options.breakGlass !== undefined ? { breakGlass: options.breakGlass } : {}),
    });
  }

  /** Current kill switch state (verified). */
  async status(): Promise<KillSwitchStatus> {
    return this.requireKillSwitch().checkStatus();
  }

  /** Opens the SSE channel: a halt arrives in milliseconds instead of at the next poll. */
  async startStream(): Promise<() => void> {
    return this.requireKillSwitch().startStream();
  }

  /**
   * Evaluates an action and decides. This is the only place where a decision is made.
   * Returns the decision when the action may proceed; otherwise throws.
   */
  async decide(action: Record<string, unknown>, agent: string): Promise<ParsedDecision> {
    this.assertAgent(agent);

    // 1. The kill switch is evaluated BEFORE policy: a stopped agent does not even query the
    //    policy engine, and above all does not consume plan quota.
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
            reason: 'explicit fail-open: ' + error.message,
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
      throw new GuardUnavailableError('evaluation failed: ' + (error as Error).message);
    }

    // 2. Positive allow-list. An unparseable body is a denial, not an exception.
    const parsed = parseVerdict(outcome.body, this.expectedAgent);
    if (!parsed.ok) {
      throw new GuardBlockedError(parsed.detail + ' (' + parsed.code + ')', null, null);
    }
    const decision = parsed.decision;

    // 3. Verdict signature: if configured, a missing or invalid signature is a denial.
    if (this.verify) {
      const signature = outcome.headers.get(this.options.signatureHeader);
      const valid = this.verify(outcome.rawBody, signature);
      if (!valid) {
        throw new GuardBlockedError(
          'unsigned verdict or invalid signature: rejected as unauthentic',
          decision.policy,
          decision.decisionId,
        );
      }
    }

    this.emitDecision(decision, action);

    if (decision.decision === 'PAUSED') {
      // The hook is a NOTIFICATION. Whether it resolves, rejects, or throws, the action does not run.
      try {
        await this.onPaused?.(decision, action);
      } catch {
        // deliberately swallowed: a failing hook must not become an authorization
      }
      throw new GuardPausedError(decision.reason, decision.decisionId);
    }

    if (!isAuthorizing(decision.decision)) {
      throw new GuardBlockedError(decision.reason, decision.policy, decision.decisionId);
    }

    // 4. Re-check of the gate against the frozen state: no round-trip, but a halt that occurred
    //    during evaluation still stops the action (anti-TOCTOU window).
    await this.gateKillSwitch({ refresh: false });

    return decision;
  }

  /**
   * Best-effort telemetry by contract. A consumer that throws must NEVER change a security
   * decision, in either direction. I discovered this while writing the test: the first version
   * called `this.onDecision?.()` directly, and a hook that threw turned a normal BLOCKED into a
   * transport exception (unreadable for the receiver).
   */
  private emitDecision(decision: ParsedDecision, action: Record<string, unknown>): void {
    try {
      this.onDecision?.(decision, action);
    } catch {
      // deliberately swallowed: telemetry decides nothing
    }
  }

  private assertAgent(agent: string): void {
    if (!agent || agent.trim().length === 0) throw new GuardConfigError('the agent name is required');
    if (this.expectedAgent && agent !== this.expectedAgent) {
      throw new GuardBlockedError(
        'this client is pinned to agent "' + this.expectedAgent + '" but the action was requested for "' + agent + '"',
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
        throw new GuardStateInvalidError('kill switch state too stale: ' + error.message);
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
        'the kill switch is not configured on this Guard: pass killSwitch: { tenant, agent } to the constructor',
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
