/**
 * Verdict: the guarantee that an unrecognized response does NOT authorize.
 * These tests are the re-runnable proof of the 0.1.1 defect C-01/C-02.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Guard, GuardBlockedError } from './imports.mjs';
import { makeFetch, makeAgent, approved } from './helpers.mjs';

// Teaching note: `allowedHosts` must be declared for local development too. The constraint does
// not "relax" on its own just because the host is loopback: the key must be authorized toward a
// host, always.
const BASE = {
  apiKey: 'key-0123456789abcdef',
  baseUrl: 'http://127.0.0.1:8787',
  allowInsecureHttp: true,
  allowedHosts: ['127.0.0.1'],
};

async function runWith(body, options = {}) {
  const { impl, calls } = makeFetch({ status: 200, body });
  const guard = new Guard({ ...BASE, fetchImpl: impl, ...options });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (amount) => ({ type: 'payment', amount }) });
  let error = null;
  try { await safe(4200); } catch (e) { error = e; }
  return { error, effects, calls };
}

// --- The control: APPROVED executes, otherwise the tests below prove nothing ---
test('APPROVED executes the action (positive control)', async () => {
  const { error, effects } = await runWith(approved());
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

// --- The historical defect: the DOCUMENTED schema {verdict:"block"} must block ---
test('documented schema {verdict:"block"} blocks (PoC v15)', async () => {
  const { error, effects } = await runWith({ verdict: 'block', reason: 'payment limit', policy: 'Payment limit' });
  assert.ok(error instanceof GuardBlockedError, 'expected GuardBlockedError');
  assert.deepEqual(effects, [], 'no side effect');
});

test('decision BLOCKED blocks', async () => {
  const { error, effects } = await runWith({ decision: 'BLOCKED', reason: 'denied' });
  assert.ok(error instanceof GuardBlockedError);
  assert.deepEqual(effects, []);
});

test('decision FLAGGED executes (authorizing)', async () => {
  const { error, effects } = await runWith({ decision: 'FLAGGED' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

// --- Hostile bodies: 18 variants, all must deny ---
const HOSTILE = [
  ['empty object', {}],
  ['null', null],
  ['array', []],
  ['string', 'APPROVED'],
  ['number', 200],
  ['decision null', { decision: null }],
  ['decision empty string', { decision: '' }],
  ['decision spaces', { decision: '   ' }],
  ['unknown word', { decision: 'YES_PLEASE' }],
  ['UNAVAILABLE from server', { decision: 'UNAVAILABLE' }],
  ['decision boolean', { decision: true }],
  ['decision object', { decision: { ok: true } }],
  ['unknown verdict', { verdict: 'maybe' }],
  ['reason only', { reason: 'ok' }],
  ['policy without verdict', { policy: 'P-1' }],
  ['nested error envelope', { error: { code: 'internal_error' } }],
  ['APPROVED/BLOCKED conflict', { decision: 'APPROVED', verdict: 'blocked' }],
  ['BLOCKED/approved conflict', { decision: 'BLOCKED', verdict: 'approved' }],
];

for (const [name, body] of HOSTILE) {
  test(`hostile body: ${name} -> no effect`, async () => {
    const { error, effects } = await runWith(body);
    assert.ok(error instanceof GuardBlockedError, `expected denial for ${name}, got ${error}`);
    assert.deepEqual(effects, [], `no effect for ${name}`);
  });
}

test('lowercase legacy alias `allow` executes (contract v17 R2 compatibility)', async () => {
  // Deliberate: aliases are accepted to avoid breaking 0.1.x clients during a coordinated
  // release. The backend MUST still emit the canonical `decision`. This test pins the behavior,
  // so a change of mind becomes a visible decision rather than a silent regression.
  const { error, effects } = await runWith({ decision: 'allow' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

test('legacy schema {verdict:"approve"} executes', async () => {
  const { error, effects } = await runWith({ verdict: 'approve' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

test('with expectedAgent set, a mismatched agent is denied', async () => {
  const { error, effects } = await runWith({ decision: 'APPROVED', agent: 'other-agent' }, { expectedAgent: 'billing-bot' });
  assert.ok(error instanceof GuardBlockedError);
  assert.deepEqual(effects, []);
});

test('without expectedAgent the agent pinning is not active (opt-in)', async () => {
  const { error, effects } = await runWith({ decision: 'APPROVED', agent: 'other-agent' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

test('non-numeric latency_ms does not block: it is telemetry, not authorization', async () => {
  const { error, effects } = await runWith({ decision: 'APPROVED', latency_ms: 'fast' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

test('request for an agent different from expectedAgent is denied before the network', async () => {
  const { impl, calls } = makeFetch({ status: 200, body: approved() });
  const guard = new Guard({ ...BASE, fetchImpl: impl, expectedAgent: 'billing-bot' });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'other-agent', toAction: (a) => ({ type: 'payment', amount: a }) });
  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, []);
  assert.equal(calls.evaluate, 0, 'no network call: the constraint is local');
});

test('HTML body from a captive portal -> denial', async () => {
  const { impl } = makeFetch({ status: 200, raw: '<html><body>Sign in to WiFi</body></html>' });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });
  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, []);
});

test('truncated JSON -> denial', async () => {
  const { impl } = makeFetch({ status: 200, raw: '{"decision":"APPRO' });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });
  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, []);
});
