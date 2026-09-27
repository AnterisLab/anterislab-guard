/**
 * @anterislab/guard/mock - test utilities for consumers.
 *
 * Zero-dependency mock `fetch` implementation, suitable for unit tests and
 * local development without a subscription. The mock never performs a network
 * call and contains no production logic.
 *
 * Import via subpath: `import { createMockFetch } from '@anterislab/guard/mock'`.
 */

import { createHmac } from 'node:crypto';

/** One response shape the mock can return. */
export interface MockRoute {
  status: number;
  /** Parsed JSON body. Serialized with `JSON.stringify` unless `raw` is set. */
  body?: unknown;
  /** Raw body. Takes precedence over `body`. Use for malformed-JSON tests. */
  raw?: string;
  /** Response headers, merged with the default `content-type: application/json`. */
  headers?: Record<string, string>;
  /** Artificial delay before the response is delivered, in milliseconds. */
  delayMs?: number;
}

/** Recorded call, also passed to function responders. */
export interface MockRequest {
  url: string;
  method: string;
  /** Header names are lowercased. */
  headers: Record<string, string>;
  /** Request body as a string, or null when absent. */
  body: string | null;
}

/**
 * A responder is:
 *  - a single route (same response to every call),
 *  - an array (successive responses; the last one is repeated),
 *  - a function that receives the request and returns a route.
 */
export type MockResponder =
  | MockRoute
  | readonly MockRoute[]
  | ((request: MockRequest) => MockRoute);

export interface MockFetch {
  /** Pass to `new Guard({ fetchImpl: mock.fetch })`. */
  fetch: typeof fetch;
  /** Recorded calls, in order of arrival. */
  calls: MockRequest[];
  /** Convenience: number of calls to `/api/v1/evaluate`. */
  readonly evaluateCalls: number;
  /** Reset recorded calls and restart the responder sequence. */
  reset(): void;
}

function extractHeaders(init: Parameters<typeof fetch>[1]): Record<string, string> {
  const headers: Record<string, string> = {};
  const source = init?.headers;
  if (!source) return headers;
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) headers[key.toLowerCase()] = value;
    return headers;
  }
  for (const [key, value] of Object.entries(source)) {
    headers[key.toLowerCase()] = String(value);
  }
  return headers;
}

function resolveRoute(
  responder: MockResponder,
  index: number,
  request: MockRequest,
): MockRoute {
  if (typeof responder === 'function') return responder(request);
  if (Array.isArray(responder)) {
    const sequence = responder as readonly MockRoute[];
    if (sequence.length === 0) throw new Error('mock: responder array is empty');
    const step = sequence[Math.min(index, sequence.length - 1)];
    if (step === undefined) throw new Error('mock: no route for this call');
    return step;
  }
  return responder as MockRoute;
}

/**
 * Create a mock `fetch`. Never performs a network call.
 *
 *   const mock = createMockFetch({ status: 200, body: approvedVerdict() });
 *   const guard = new Guard({ apiKey: 'test', fetchImpl: mock.fetch });
 */
export function createMockFetch(responder: MockResponder): MockFetch {
  const calls: MockRequest[] = [];
  let index = 0;

  const impl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const request: MockRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: extractHeaders(init),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(request);

    const route = resolveRoute(responder, index, request);
    index += 1;

    if (route.delayMs && route.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, route.delayMs));
    }

    const text = route.raw ?? JSON.stringify(route.body ?? {});
    return new Response(text, {
      status: route.status,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  };

  return {
    fetch: impl as typeof fetch,
    calls,
    get evaluateCalls(): number {
      return calls.filter((call) => call.url.includes('/api/v1/evaluate')).length;
    },
    reset(): void {
      calls.length = 0;
      index = 0;
    },
  };
}

/** Canonical APPROVED verdict body. */
export function approvedVerdict(
  agent = 'test-agent',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: 'APPROVED',
    reason: 'policy allows',
    policy: null,
    agent,
    latency_ms: 3,
    decision_id: 'd-1',
    ...extra,
  };
}

/** Canonical FLAGGED verdict body (authorizing). */
export function flaggedVerdict(
  agent = 'test-agent',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: 'FLAGGED',
    reason: 'flagged for review',
    policy: null,
    agent,
    latency_ms: 5,
    decision_id: 'd-2',
    ...extra,
  };
}

/** Canonical BLOCKED verdict body. */
export function blockedVerdict(
  reason = 'denied',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: 'BLOCKED',
    reason,
    policy: null,
    agent: 'test-agent',
    latency_ms: 2,
    decision_id: 'd-3',
    ...extra,
  };
}

/** Canonical PAUSED verdict body. */
export function pausedVerdict(
  reason = 'human review required',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    decision: 'PAUSED',
    reason,
    policy: null,
    agent: 'test-agent',
    latency_ms: 4,
    decision_id: 'd-4',
    ...extra,
  };
}

/**
 * HMAC-SHA256 signature over the raw body, formatted as `sha256=<hex>`,
 * matching what `verifyVerdict` expects from the backend.
 */
export function signBody(secret: string, rawBody: string): string {
  return (
    'sha256=' +
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  );
}
