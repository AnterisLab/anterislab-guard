/**
 * Trasporto: timeout, retry, quota, rate limit, idempotenza.
 * Qui vive il difetto A-05/M-02 della 0.1.1: Retry-After ignorato e timeout che non copriva
 * la lettura del corpo.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Guard, GuardQuotaError, GuardAuthError, GuardUnavailableError, GuardBlockedError } from './imports.mjs';
import { makeAgent, approved } from './helpers.mjs';

const BASE = {
  apiKey: 'key-0123456789abcdef',
  baseUrl: 'http://127.0.0.1:8787',
  allowInsecureHttp: true,
  allowedHosts: ['127.0.0.1'],
};

/** fetch che risponde con una sequenza di esiti e registra gli header di ogni tentativo. */
function sequencedFetch(steps) {
  let index = 0;
  const seen = [];
  const impl = async (url, init) => {
    seen.push({
      url: String(url),
      idempotencyKey: init?.headers?.['idempotency-key'] ?? null,
      authorization: init?.headers?.authorization ?? null,
    });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    const text = step.raw ?? JSON.stringify(step.body ?? {});
    return new Response(text, { status: step.status, headers: { 'content-type': 'application/json', ...(step.headers ?? {}) } });
  };
  return { impl, seen };
}

function agentFor(guard) {
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });
  return { safe, effects };
}

// --- 402: la quota e' una barriera, con qualunque impostazione di failOpen ---
for (const failOpen of [false, true]) {
  test(`402 SUPPORTA la quota come barriera (failOpen=${failOpen})`, async () => {
    const { impl, seen } = sequencedFetch([{ status: 402, body: { code: 'quota_exceeded', plan: 'starter', limit: 500, used: 500 } }]);
    const guard = new Guard({ ...BASE, fetchImpl: impl, failOpen, retries: 2 });
    const { safe, effects } = agentFor(guard);

    await assert.rejects(() => safe(10), GuardQuotaError);
    assert.deepEqual(effects, [], 'nessun effetto: il 402 non si aggira');
    assert.equal(seen.length, 1, 'il 402 e terminale: nessun retry');
  });
}

test('402 espone piano, limite e consumo', async () => {
  const { impl } = sequencedFetch([{ status: 402, body: { error: 'quota_exceeded', plan: 'pro', limit: 5000, used: 5000 } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { safe } = agentFor(guard);
  try {
    await safe(10);
    assert.fail('atteso GuardQuotaError');
  } catch (error) {
    assert.ok(error instanceof GuardQuotaError);
    assert.equal(error.plan, 'pro');
    assert.equal(error.limit, 5000);
    assert.equal(error.used, 5000);
  }
});

// --- 401/403: terminali, mai ritentati ---
test('401 e terminale e non viene ritentato', async () => {
  const { impl, seen } = sequencedFetch([{ status: 401, body: { code: 'invalid_api_key' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 3 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(1), GuardAuthError);
  assert.equal(seen.length, 1);
  assert.deepEqual(effects, []);
});

test('403 agent_not_in_scope e terminale', async () => {
  const { impl, seen } = sequencedFetch([{ status: 403, body: { code: 'agent_not_in_scope' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 3 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(1), GuardAuthError);
  assert.equal(seen.length, 1);
  assert.deepEqual(effects, []);
});

// --- 429: si attende il Retry-After dichiarato, non lo si ignora ---
test('429 con Retry-After breve viene atteso e poi rieseguito', async () => {
  const { impl, seen } = sequencedFetch([
    { status: 429, headers: { 'retry-after': '0' }, body: { code: 'rate_limited' } },
    { status: 200, body: approved() },
  ]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 1 });
  const { safe, effects } = agentFor(guard);
  await safe(10);
  assert.equal(seen.length, 2, 'ha ritentato dopo il 429');
  assert.deepEqual(effects, ['charge:10']);
});

test('429 con Retry-After oltre il budget non viene aggirato: fail-closed', async () => {
  const { impl, seen } = sequencedFetch([{ status: 429, headers: { 'retry-after': '9999' }, body: { code: 'rate_limited' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 5, maxRetryAfterMs: 1000 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.equal(seen.length, 1, 'non ha tentato di nuovo subito');
  assert.deepEqual(effects, []);
});

test('429 senza Retry-After non viene interpretato: rifiuto', async () => {
  const { impl } = sequencedFetch([{ status: 429, body: { code: 'rate_limited' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 3 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});

// --- 5xx: ritentato entro budget, poi fail-closed ---
test('5xx viene ritentato e poi riesce', async () => {
  const { impl, seen } = sequencedFetch([{ status: 503, body: { code: 'guard_unavailable' } }, { status: 200, body: approved() }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 2 });
  const { safe, effects } = agentFor(guard);
  await safe(10);
  assert.equal(seen.length, 2);
  assert.deepEqual(effects, ['charge:10']);
});

test('5xx persistente produce fail-closed (non fail-open)', async () => {
  const { impl } = sequencedFetch([{ status: 500, body: { code: 'internal_error' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 2 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});

test('failOpen: true prosegue ma NON registra mai APPROVED reale', async () => {
  const { impl } = sequencedFetch([{ status: 500, body: { code: 'internal_error' } }]);
  const decisions = [];
  const guard = new Guard({
    ...BASE,
    fetchImpl: impl,
    retries: 0,
    failOpen: true,
    onDecision: (d) => decisions.push(d),
  });
  const { safe, effects } = agentFor(guard);
  await safe(10);
  assert.deepEqual(effects, ['charge:10']);
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].reason, /fail-open/i);
});

// --- Idempotenza: stessa chiave su ogni tentativo, quota consumata una volta ---
test('l\'Idempotency-Key e riusata identica su ogni retry', async () => {
  const { impl, seen } = sequencedFetch([{ status: 503 }, { status: 200, body: approved() }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 2 });
  const { safe } = agentFor(guard);
  await safe(10);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].idempotencyKey, 'la chiave e presente');
  assert.equal(seen[0].idempotencyKey, seen[1].idempotencyKey, 'stessa chiave sui due tentativi');
});

test('due azioni diverse usano due chiavi diverse', async () => {
  const { impl, seen } = sequencedFetch([{ status: 200, body: approved() }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { safe } = agentFor(guard);
  await safe(10);
  await safe(20);
  assert.notEqual(seen[0].idempotencyKey, seen[1].idempotencyKey);
});

test('la chiave API non compare mai nell\'URL', async () => {
  const { impl, seen } = sequencedFetch([{ status: 200, body: approved() }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { safe } = agentFor(guard);
  await safe(10);
  assert.ok(!seen[0].url.includes(BASE.apiKey), 'la chiave non e nell URL');
  assert.ok(seen[0].authorization.startsWith('Bearer '), 'la chiave viaggia solo nell header Authorization');
});

// --- Timeout: copre anche la lettura del corpo (difetto M-02) ---
test('timeout che scade durante la lettura del corpo produce fail-closed', async () => {
  // Header immediati, corpo che non arriva mai: e' il caso che la 0.1.1 non copriva.
  const impl = async () => {
    const stream = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          try { controller.enqueue(new TextEncoder().encode(JSON.stringify(approved()))); controller.close(); } catch { /* gia chiuso */ }
        }, 2000);
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const guard = new Guard({ ...BASE, fetchImpl: /** @type {typeof fetch} */ (impl), timeoutMs: 80, retries: 0 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});

test('una risposta enorme viene rifiutata invece che elaborata', async () => {
  const huge = JSON.stringify({ decision: 'APPROVED', padding: 'x'.repeat(300_000) });
  const impl = async () => new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } });
  const guard = new Guard({ ...BASE, fetchImpl: /** @type {typeof fetch} */ (impl), retries: 0 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});

test('se la risposta echosse la chiave API, viene rifiutata', async () => {
  const impl = async () => new Response(`{"decision":"APPROVED","leak":"${BASE.apiKey}"}`, { status: 200 });
  const guard = new Guard({ ...BASE, fetchImpl: /** @type {typeof fetch} */ (impl), retries: 0 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});
