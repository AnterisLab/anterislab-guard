/**
 * HTTP transport to /api/v1/evaluate.
 *
 * Non-negotiable constraints, which are also why this file exists separately:
 *  - the timeout covers the ENTIRE transaction, including body reads (an endpoint that responds
 *    with headers and then goes silent must not block the agent forever);
 *  - retries cover only transport failures and 5xx. Never 401/402/403/409;
 *  - on 429 the DECLARED `Retry-After` is honored in full, or the request is rejected: it is
 *    not ignored;
 *  - the API key never appears in a URL, a body, or an error message;
 *  - the `Idempotency-Key` is generated once and reused on every attempt, so a retry does not
 *    consume plan quota twice.
 */

import { GuardAuthError, GuardPolicyError, GuardQuotaError, GuardUnavailableError } from './errors.js';

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries: number;
  maxRetryAfterMs: number;
  idempotency: boolean;
  sdkVersion: string;
  fetchImpl?: typeof fetch;
}

export interface TransportResponse {
  status: number;
  body: unknown;
  headers: Headers;
  /** Exact body bytes: needed for HMAC signature verification. */
  rawBody: string;
}

/** A terminal HTTP error: mapped onto a class of the GuardError hierarchy. */
export function mapHttpError(status: number, body: unknown): Error {
  const record = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : `HTTP ${status}`;

  switch (status) {
    case 401:
      return new GuardAuthError(401, 'API key missing, invalid, or revoked');
    case 402:
      return new GuardQuotaError(
        typeof record.plan === 'string' ? record.plan : null,
        typeof record.limit === 'number' ? record.limit : null,
        typeof record.used === 'number' ? record.used : null,
      );
    case 403:
      return new GuardAuthError(403, String(record.code ?? 'agent_not_in_scope'));
    case 409:
      return new GuardPolicyError(
        message,
        typeof record.expected === 'string' ? record.expected : null,
        typeof record.received === 'string' ? record.received : null,
      );
    default:
      return new GuardUnavailableError(`the guard responded with HTTP ${status}: ${message}`);
  }
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Transport {
  private readonly options: TransportOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TransportOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Runs an evaluation. It does not interpret the verdict: it returns the raw response.
   * A non-200 outcome that is a terminal HTTP error is thrown here.
   */
  async evaluate(
    payload: { agent: string; action: Record<string, unknown>; context?: Record<string, unknown> },
    idempotencyKey: string | null,
  ): Promise<TransportResponse> {
    const endpoint = `${this.options.baseUrl}/api/v1/evaluate`;
    const body = JSON.stringify(payload);
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
        'x-anterislab-sdk': this.options.sdkVersion,
        'user-agent': `@anterislab/guard/${this.options.sdkVersion}`,
      };
      if (this.options.idempotency && idempotencyKey) headers['idempotency-key'] = idempotencyKey;

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.options.timeoutMs);

      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        // The timeout must also cover body reads: `fetch` resolves as soon as headers arrive,
        // so a slow read would otherwise be unbounded. And `AbortController` is not enough: a
        // broken `fetch` (or a polyfill that ignores the signal) would block the agent forever.
        // The deadline is therefore enforced HERE, on wait time.
        let rawBody: string;
        try {
          rawBody = await this.withDeadline(response.text(), () => {
            timedOut = true;
            controller.abort();
          });
        } finally {
          clearTimeout(timer);
        }

        if (rawBody.length > 262_144) {
          throw new GuardUnavailableError('the guard response exceeds 256 KiB: rejected');
        }

        let parsed: unknown = null;
        if (rawBody.trim().length > 0) {
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            // A non-JSON body (captive portal, proxy error page) is a failure, not a permission.
            // It becomes an unparseable 200 response -> downstream denial.
            parsed = null;
          }
        }
        this.assertNoKeyLeak(rawBody);

        if (response.status === 429) {
          const waitMs = parseRetryAfter(response.headers);
          if (waitMs === null) throw new GuardUnavailableError('rate limit without Retry-After: nothing is assumed');
          if (waitMs > this.options.maxRetryAfterMs || attempt > this.options.retries) {
            throw new GuardUnavailableError(
              `rate limit requesting a wait of ${Math.round(waitMs / 1000)} s, over the allowed budget`,
            );
          }
          await sleep(waitMs + Math.floor(Math.random() * 250));
          continue;
        }

        if (response.status >= 500) {
          if (attempt > this.options.retries) {
            throw new GuardUnavailableError(`the guard is unavailable (HTTP ${response.status})`);
          }
          await sleep(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
          continue;
        }

        if (response.status >= 400) throw mapHttpError(response.status, parsed);

        return { status: response.status, body: parsed, headers: response.headers, rawBody };
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof Error && error.name.startsWith('Guard')) throw error;
        if (timedOut) throw new GuardUnavailableError(`timeout (${this.options.timeoutMs} ms) to ${this.options.baseUrl}`);
        if (attempt > this.options.retries) {
          throw new GuardUnavailableError(`network failure to ${this.options.baseUrl}: ${(error as Error).message}`);
        }
        await sleep(200 * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Enforces a deadline on any promise. It exists because the timeout must not depend on the
   * good will of the `fetch` implementation: if the signal is ignored, the agent must still
   * regain control and deny the action.
   */
  private async withDeadline<T>(promise: Promise<T>, onTimeout: () => void): Promise<T> {
    void promise.catch(() => undefined); // the losing side of the race must not remain unhandled
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(
              new GuardUnavailableError(
                `timeout (${this.options.timeoutMs} ms) while reading the response body`,
              ),
            );
          }, this.options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Defense in depth: the key must never end up in a response or error body. */
  private assertNoKeyLeak(rawBody: string): void {
    if (this.options.apiKey.length >= 16 && rawBody.includes(this.options.apiKey)) {
      throw new GuardUnavailableError('the guard response contained the API key: rejected');
    }
  }
}
