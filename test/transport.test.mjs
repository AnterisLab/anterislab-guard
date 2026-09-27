/**
 * Transport: timeout, retry, quota, rate limit, idempotency.
 * Here lives the 0.1.1 defect A-05/M-02: Retry-After ignored and a timeout that did not cover
 * body reads.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Guard, GuardQuotaError, GuardAuthError, GuardUnavailableError } from './imports.mjs';
import { makeAgent, approved } from './helpers.mjs';

const BASE = {
  apiKey: 'key-0123456789abcdef',
  baseUrl: 'http://127.0.0.1:8787',
  allowInsecureHttp: true,
  allowedHosts: ['127.0.0.1'],
};

/** fetch that responds with a sequence of outcomes and records the headers of every attempt. */
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

// --- 402: quota is a barrier, regardless of the failOpen setting ---
for (const failOpen of [false, true]) {
  test(`402 holds quota as a barrier (failOpen=${failOpen})`, async () => {
    const { impl, seen } = sequencedFetch([{ status: 402, body: { code: 'quota_exceeded', plan: 'starter', limit: 500, used: 500 } }]);
    const guard = new Guard({ ...BASE, fetchImpl: impl, failOpen, retries: 2 });
    const { safe, effects } = agentFor(guard);

    await assert.rejects(() => safe(10), GuardQuotaError);
    assert.deepEqual(effects, [], 'no effect: the 402 is not bypassed');
    assert.equal(seen.length, 1, 'the 402 is terminal: no retry');
  });
}

test('402 exposes plan, limit and usage', async () => {
  const { impl } = sequencedFetch([{ status: 402, body: { error: 'quota_exceeded', plan: 'pro', limit: 5000, used: 5000 } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { safe } = agentFor(guard);
  try {
    await safe(10);
    assert.fail('expected GuardQuotaError');
  } catch (error) {
    assert.ok(error instanceof GuardQuotaError);
    assert.equal(error.plan, 'pro');
    assert.equal(error.limit, 5000);
    assert.equal(error.used, 5000);
  }
});

// --- 401/403: terminal, never retried ---
test('401 is terminal and is not retried', async () => {
  const { impl, seen } = sequencedFetch([{ status: 401, body: { code: 'invalid_api_key' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 3 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(1), GuardAuthError);
  assert.equal(seen.length, 1);
  assert.deepEqual(effects, []);
});

test('403 agent_not_in_scope is terminal', async () => {
  const { impl, seen } = sequencedFetch([{ status: 403, body: { code: 'agent_not_in_scope' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 3 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(1), GuardAuthError);
  assert.equal(seen.length, 1);
  assert.deepEqual(effects, []);
});

// --- 429: the declared Retry-After is honored, not ignored ---
test('429 with a short Retry-After is waited for and then retried', async () => {
  const { impl, seen } = sequencedFetch([
    { status: 429, headers: { 'retry-after': '0' }, body: { code: 'rate_limited' } },
    { status: 200, body: approved() },
  ]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 1 });
  const { safe, effects } = agentFor(guard);
  await safe(10);
  assert.equal(seen.length, 2, 'retried after the 429');
  assert.deepEqual(effects, ['charge:10']);
});

test('429 with a Retry-After beyond the budget is not bypassed: fail-closed', async () => {
  const { impl, seen } = sequencedFetch([{ status: 429, headers: { 'retry-after': '9999' }, body: { code: 'rate_limited' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 5, maxRetryAfterMs: 1000 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.equal(seen.length, 1, 'did not try again immediately');
  assert.deepEqual(effects, []);
});

test('429 without Retry-After is not interpreted: rejection', async () => {
  const { impl } = sequencedFetch([{ status: 429, body: { code: 'rate_limited' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 3 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});

// --- 5xx: retried within the budget, then fail-closed ---
test('5xx is retried and then succeeds', async () => {
  const { impl, seen } = sequencedFetch([{ status: 503, body: { code: 'guard_unavailable' } }, { status: 200, body: approved() }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 2 });
  const { safe, effects } = agentFor(guard);
  await safe(10);
  assert.equal(seen.length, 2);
  assert.deepEqual(effects, ['charge:10']);
});

test('persistent 5xx produces fail-closed (not fail-open)', async () => {
  const { impl } = sequencedFetch([{ status: 500, body: { code: 'internal_error' } }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 2 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});

test('failOpen: true proceeds but NEVER records a real APPROVED', async () => {
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

// --- Idempotency: same key on every attempt, quota consumed once ---
test('the Idempotency-Key is reused identically on every retry', async () => {
  const { impl, seen } = sequencedFetch([{ status: 503 }, { status: 200, body: approved() }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl, retries: 2 });
  const { safe } = agentFor(guard);
  await safe(10);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].idempotencyKey, 'the key is present');
  assert.equal(seen[0].idempotencyKey, seen[1].idempotencyKey, 'same key on both attempts');
});

test('two different actions use two different keys', async () => {
  const { impl, seen } = sequencedFetch([{ status: 200, body: approved() }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { safe } = agentFor(guard);
  await safe(10);
  await safe(20);
  assert.notEqual(seen[0].idempotencyKey, seen[1].idempotencyKey);
});

test('the API key never appears in the URL', async () => {
  const { impl, seen } = sequencedFetch([{ status: 200, body: approved() }]);
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { safe } = agentFor(guard);
  await safe(10);
  assert.ok(!seen[0].url.includes(BASE.apiKey), 'the key is not in the URL');
  assert.ok(seen[0].authorization.startsWith('Bearer '), 'the key travels only in the Authorization header');
});

// --- Timeout: covers body reads too (defect M-02) ---
test('timeout expiring during the body read produces fail-closed', async () => {
  // Immediate headers, a body that never arrives: this is the case 0.1.1 did not cover.
  const impl = async () => {
    const stream = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          try { controller.enqueue(new TextEncoder().encode(JSON.stringify(approved()))); controller.close(); } catch { /* already closed */ }
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

test('a huge response is rejected instead of being processed', async () => {
  const huge = JSON.stringify({ decision: 'APPROVED', padding: 'x'.repeat(300_000) });
  const impl = async () => new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } });
  const guard = new Guard({ ...BASE, fetchImpl: /** @type {typeof fetch} */ (impl), retries: 0 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});

test('if the response echoes the API key, it is rejected', async () => {
  const impl = async () => new Response(`{"decision":"APPROVED","leak":"${BASE.apiKey}"}`, { status: 200 });
  const guard = new Guard({ ...BASE, fetchImpl: /** @type {typeof fetch} */ (impl), retries: 0 });
  const { safe, effects } = agentFor(guard);
  await assert.rejects(() => safe(10), GuardUnavailableError);
  assert.deepEqual(effects, []);
});
