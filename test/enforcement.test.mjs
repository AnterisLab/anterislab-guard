/**
 * Enforcement: the guarantee that the action is NOT executed when it must not be.
 * Every test counts the REAL side effects produced by the instrumented agent, because
 * "it did not throw" is weaker evidence than "nothing happened".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Guard, GuardPausedError, GuardBlockedError, GuardConfigError } from './imports.mjs';
import { makeFetch, makeAgent, approved, signBody } from './helpers.mjs';

const BASE = {
  apiKey: 'key-0123456789abcdef',
  baseUrl: 'http://127.0.0.1:8787',
  allowInsecureHttp: true,
  allowedHosts: ['127.0.0.1'],
};

// --- Coverage: wrap() protects ALL methods, not just the first one ---
test('wrap() intercepts every method, not just one (defect A-01)', async () => {
  const { impl } = makeFetch({ status: 200, body: { decision: 'BLOCKED', reason: 'denied' } });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrap(agent, { agent: 'billing-bot' });

  await assert.rejects(() => safe.charge(10), GuardBlockedError);
  await assert.rejects(() => safe.refund(10), GuardBlockedError);

  assert.deepEqual(effects, [], 'neither method produced any effect');
});

test('explicit passthrough skips the gate only for declared methods', async () => {
  const { impl } = makeFetch({ status: 200, body: { decision: 'BLOCKED', reason: 'denied' } });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrap(agent, { agent: 'billing-bot', passthrough: ['describe'] });

  assert.equal(safe.describe(), 'instrumented agent', 'describe is passthrough');
  await assert.rejects(() => safe.charge(10), GuardBlockedError);
  assert.deepEqual(effects, []);
});

test('with APPROVED both methods execute (positive control)', async () => {
  const { impl } = makeFetch({ status: 200, body: approved() });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrap(agent, { agent: 'billing-bot' });

  await safe.charge(10);
  await safe.refund(20);
  assert.deepEqual(effects, ['charge:10', 'refund:20']);
});

// --- PAUSED always blocks, whatever the hook does ---
for (const hookCase of ['resolves', 'rejects', 'throws']) {
  test(`PAUSED blocks even when onPaused ${hookCase}`, async () => {
    const { impl } = makeFetch({ status: 200, body: { decision: 'PAUSED', reason: 'human review required', decision_id: 'd-9' } });
    let hookCalls = 0;
    const onPaused = async () => {
      hookCalls += 1;
      if (hookCase === 'rejects') throw new Error('reviewer unreachable');
      if (hookCase === 'throws') throw new Error('boom');
    };
    const guard = new Guard({ ...BASE, fetchImpl: impl, onPaused });
    const { agent, effects } = makeAgent();
    const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

    await assert.rejects(() => safe(5000), GuardPausedError);
    assert.equal(hookCalls, 1, 'the hook was notified');
    assert.deepEqual(effects, [], 'the hook did NOT authorize anything');
  });
}

test('onDecision is invoked but cannot change the outcome', async () => {
  const { impl } = makeFetch({ status: 200, body: { decision: 'BLOCKED', reason: 'no' } });
  const seen = [];
  const guard = new Guard({
    ...BASE,
    fetchImpl: impl,
    onDecision: (decision) => { seen.push(decision.decision); throw new Error('broken telemetry'); },
  });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

  await assert.rejects(() => safe(1), GuardBlockedError);
  assert.deepEqual(seen, ['BLOCKED']);
  assert.deepEqual(effects, []);
});

// --- Verdict signature ---
const SECRET = 'shared-secret-long-enough';

test('with verifyVerdict, an unsigned APPROVED verdict is denied', async () => {
  const body = JSON.stringify(approved());
  const { impl } = makeFetch({ status: 200, raw: body });
  const guard = new Guard({ ...BASE, fetchImpl: impl, verifyVerdict: SECRET });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, [], 'an unauthentic APPROVED does not authorize');
});

test('with verifyVerdict, a valid signature lets the action through', async () => {
  const body = JSON.stringify(approved());
  const { impl } = makeFetch({ status: 200, raw: body, headers: { 'x-anterislab-signature': signBody(SECRET, body) } });
  const guard = new Guard({ ...BASE, fetchImpl: impl, verifyVerdict: SECRET });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

  await safe(10);
  assert.deepEqual(effects, ['charge:10']);
});

test('a valid signature over a DIFFERENT body does not authorize', async () => {
  const body = JSON.stringify(approved());
  const { impl } = makeFetch({ status: 200, raw: body, headers: { 'x-anterislab-signature': signBody(SECRET, body + ' ') } });
  const guard = new Guard({ ...BASE, fetchImpl: impl, verifyVerdict: SECRET });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, []);
});

// --- Configuration that would weaken guarantees: rejected at construction ---
test('non-loopback http:// baseUrl is rejected at construction', () => {
  assert.throws(
    () => new Guard({ ...BASE, baseUrl: 'http://evil.example', allowedHosts: ['evil.example'] }),
    GuardConfigError,
  );
});

test('a host not in allowedHosts is rejected', () => {
  assert.throws(() => new Guard({ ...BASE, baseUrl: 'https://evil.example' }), GuardConfigError);
});

test('without apiKey the constructor rejects', () => {
  assert.throws(() => new Guard({ ...BASE, apiKey: '' }), GuardConfigError);
});

test('http:// on loopback is allowed only with allowInsecureHttp', () => {
  assert.throws(() => new Guard({ ...BASE, allowInsecureHttp: false }), GuardConfigError);
});

test('a signing secret that is too short is rejected', () => {
  assert.throws(() => new Guard({ ...BASE, verifyVerdict: 'short' }), GuardConfigError);
});

test('killSwitch absent: halt() says so explicitly instead of pretending', async () => {
  const { impl } = makeFetch({ status: 200, body: approved() });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  await assert.rejects(() => guard.halt('test'), GuardConfigError);
});
