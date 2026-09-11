/**
 * @anterislab/guard — Real-time policy guard for autonomous agents.
 * Every action is evaluated against your plain-language policies
 * BEFORE it executes. https://www.anterislab.com
 */

export type ActionType =
  | 'payment' | 'refund' | 'email' | 'message'
  | 'sql' | 'http' | 'file' | 'other';

export interface GuardAction {
  type: ActionType;
  target?: string;
  domain?: string;
  amount?: number;
  currency?: string;
  recipients?: number;
  query?: string;
  direction?: 'inbound' | 'outbound';
  external?: boolean;
  metadata?: Record<string, unknown>;
}

export type DecisionKind = 'APPROVED' | 'FLAGGED' | 'PAUSED' | 'BLOCKED';

export interface GuardDecision {
  decision: DecisionKind;
  reason: string;
  policy: string | null;
  agent: string;
  latency_ms: number;
}

export interface GuardOptions {
  /** Create one in your dashboard → API Keys */
  apiKey: string;
  /** Default: https://www.anterislab.com (self-hosted/enterprise can override) */
  baseUrl?: string;
  /** Per-request timeout. Default 5000ms */
  timeoutMs?: number;
  /** Retries on network failure. Default 1 */
  retries?: number;
  /** If true, actions proceed when the guard is unreachable. Default false (fail closed) */
  failOpen?: boolean;
  /** Called on every decision — use it for your own telemetry */
  onDecision?: (decision: GuardDecision, action: GuardAction) => void;
  /** Called when a decision is PAUSED. Default: throw GuardPausedError */
  onPaused?: (decision: GuardDecision, action: GuardAction) => void | Promise<void>;
}

export class GuardError extends Error {
  constructor(message: string, public readonly decision?: GuardDecision) {
    super(message);
    this.name = 'GuardError';
  }
}

export class GuardBlockedError extends GuardError {
  constructor(d: GuardDecision) {
    super(`[AnterisLab] action BLOCKED by policy "${d.policy ?? 'n/a'}": ${d.reason}`, d);
    this.name = 'GuardBlockedError';
  }
}

export class GuardPausedError extends GuardError {
  constructor(d: GuardDecision) {
    super(`[AnterisLab] action PAUSED for human review: ${d.reason}`, d);
    this.name = 'GuardPausedError';
  }
}

export class GuardUnavailableError extends GuardError {
  constructor(message: string) {
    super(`[AnterisLab] guard unreachable: ${message}`);
    this.name = 'GuardUnavailableError';
  }
}

const DEFAULT_BASE = 'https://www.anterislab.com';

export class Guard {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly failOpen: boolean;
  private readonly onDecision?: GuardOptions['onDecision'];
  private readonly onPaused?: GuardOptions['onPaused'];

  constructor(options: GuardOptions) {
    if (!options?.apiKey) {
      throw new GuardError('apiKey is required — create one in your AnterisLab dashboard → API Keys');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.retries = options.retries ?? 1;
    this.failOpen = options.failOpen ?? false;
    this.onDecision = options.onDecision;
    this.onPaused = options.onPaused;
  }

  /** Evaluate an action against your policies. Executes nothing. */
  async check(agent: string, action: GuardAction): Promise<GuardDecision> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const res = await fetch(`${this.baseUrl}/api/v1/evaluate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ agent, action }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.status === 401) throw new GuardError('Invalid or revoked API key');
        if (!res.ok) throw new GuardError(`evaluate endpoint returned HTTP ${res.status}`);
        const decision = (await res.json()) as GuardDecision;
        this.onDecision?.(decision, action);
        return decision;
      } catch (err) {
        lastErr = err;
        if (err instanceof GuardError && err.message.includes('API key')) throw err;
      }
    }
    if (this.failOpen) {
      const fallback: GuardDecision = {
        decision: 'APPROVED',
        reason: `guard unreachable (${(lastErr as Error)?.message ?? 'network error'}) — failOpen enabled`,
        policy: null,
        agent,
        latency_ms: -1,
      };
      this.onDecision?.(fallback, action);
      return fallback;
    }
    throw new GuardUnavailableError((lastErr as Error)?.message ?? 'unknown error');
  }

  /**
   * Wrap an async function: the action is evaluated BEFORE fn runs.
   * BLOCKED → throws GuardBlockedError · PAUSED → onPaused hook or GuardPausedError.
   */
  wrapFn<A extends unknown[], R>(
    fn: (...args: A) => Promise<R> | R,
    opts: { agent: string; toAction: (...args: A) => GuardAction },
  ): (...args: A) => Promise<R> {
    return async (...args: A) => {
      const action = opts.toAction(...args);
      const d = await this.check(opts.agent, action);
      if (d.decision === 'BLOCKED') throw new GuardBlockedError(d);
      if (d.decision === 'PAUSED') {
        if (this.onPaused) await this.onPaused(d, action);
        else throw new GuardPausedError(d);
      }
      return fn(...args);
    };
  }

  /**
   * One-line wrap for agent objects: guards the given method (default "execute").
   *   const safe = guard.wrap(agent, { agent: 'billing-bot', toAction: (a) => a });
   *   await safe.execute({ type: 'payment', amount: 4200, currency: 'EUR' });
   */
  wrap<T extends Record<string, any>>(
    agentObj: T,
    opts: { agent: string; method?: string; toAction: (...args: any[]) => GuardAction },
  ): T {
    const method = opts.method ?? 'execute';
    const original = agentObj[method];
    if (typeof original !== 'function') {
      throw new GuardError(`wrap(): agent object has no method "${method}" — pass opts.method`);
    }
    const wrapped = this.wrapFn(original.bind(agentObj), opts);
    return new Proxy(agentObj, {
      get(target, prop, receiver) {
        if (prop === method) return wrapped;
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as T;
  }
}

export default Guard;
