/**
 * Test scaffolding: a *fake* guard as `fetch`, which responds to /api/v1/evaluate.
 * No real network: the tests exercise the SDK behavior, not connectivity.
 */

import { createHmac } from 'node:crypto';

/**
 * @typedef {object} MockRoute
 * @property {number} status
 * @property {unknown} [body]
 * @property {string} [raw]
 * @property {Record<string,string>} [headers]
 * @property {number} [delayMs]  Artificial delay in ms, for timeout tests.
 */

/** Builds a fake `fetch` and counts calls to /api/v1/evaluate. */
export function makeFetch(route) {
  const calls = { evaluate: 0, urls: [] };
  const impl = async (url, init) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.urls.push(href);

    if (href.includes('/api/v1/evaluate')) {
      calls.evaluate += 1;
      const resolved = typeof route === 'function' ? route(init ?? {}) : route;
      if (resolved.delayMs) await new Promise((r) => setTimeout(r, resolved.delayMs));
      const text = resolved.raw ?? JSON.stringify(resolved.body ?? {});
      return new Response(text, {
        status: resolved.status,
        headers: { 'content-type': 'application/json', ...(resolved.headers ?? {}) },
      });
    }

    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
  };
  return { impl: /** @type {typeof fetch} */ (impl), calls };
}

/** Positive response body, so denial tests have a control case. */
export function approved(agent = 'billing-bot', extra = {}) {
  return { decision: 'APPROVED', reason: 'policy allows', policy: null, agent, latency_ms: 3, decision_id: 'd-1', ...extra };
}

/** HMAC-SHA256 signature over the raw body, as the backend would produce. */
export function signBody(secret, rawBody) {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Instrumented agent: counts the side effects actually produced. */
export function makeAgent() {
  const effects = [];
  const agent = {
    async charge(amount) {
      effects.push(`charge:${amount}`);
      return 'ok';
    },
    async refund(amount) {
      effects.push(`refund:${amount}`);
      return 'ok';
    },
    describe() {
      return 'instrumented agent';
    },
  };
  return { agent, effects };
}
