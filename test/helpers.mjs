/**
 * Impalcatura di test: un guard *finto* come `fetch`, che risponde a /api/v1/evaluate.
 * Nessuna rete reale: i test provano il comportamento del SDK, non la connettivita'.
 */

import { createHmac } from 'node:crypto';

/**
 * @typedef {object} MockRoute
 * @property {number} status
 * @property {unknown} [body]
 * @property {string} [raw]
 * @property {Record<string,string>} [headers]
 * @property {number} [delayMs]  Ritardo artificiale in ms, per i test di timeout.
 */

/** Costruisce un `fetch` finto e conta le chiamate a /api/v1/evaluate. */
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

/** Corpo di risposta positivo, cosi' i test di diniego hanno un controllo. */
export function approved(agent = 'billing-bot', extra = {}) {
  return { decision: 'APPROVED', reason: 'policy consente', policy: null, agent, latency_ms: 3, decision_id: 'd-1', ...extra };
}

/** Firma HMAC-SHA256 sul corpo grezzo, come farebbe il backend. */
export function signBody(secret, rawBody) {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Agente strumentato: conta gli effetti collaterali realmente prodotti. */
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
      return 'agent strumentato';
    },
  };
  return { agent, effects };
}
