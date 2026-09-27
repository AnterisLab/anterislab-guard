/**
 * Kill switch: local halt, verified state, fail-closed posture, epoch anti-rollback,
 * and the local hash-chained audit trail.
 *
 * The signed state tokens used here are HS256 for test simplicity. Production uses
 * EdDSA by default (the algorithm allow-list is opt-in for HS256). The verification
 * pipeline (JWS structure, claim rules, epoch, scope) is identical for both.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';

import {
  KillSwitchManager,
  KillSwitchHaltedError,
  KillSwitchUnavailableError,
  KillSwitchLocalHaltError,
} from './imports.mjs';
import { createMockFetch } from '../dist/mock.js';

const TENANT = 'test-tenant';
const AGENT = 'test-agent';
const AUDIENCE = 'anterislab-guard';
const ISSUER = 'anterislab';
const SECRET = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 bytes
const SECRET_B64U = SECRET.toString('base64url');
const KID = 'test-kid';

function b64u(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function buildSignedToken(claims, kid = KID) {
  const header = { alg: 'HS256', kid, typ: 'anterislab-killswitch+jws', v: 1 };
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(claims));
  const signingInput = `${h}.${p}`;
  const sig = createHmac('sha256', SECRET).update(signingInput).digest();
  return `${signingInput}.${b64u(sig)}`;
}

function baseClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: TENANT,
    iat: now,
    nbf: now - 1,
    exp: now + 60,
    jti: 'jti-' + Math.random().toString(36).slice(2),
    epoch: 1,
    state: 'RUNNING',
    scope: { tenant: TENANT, agent: AGENT },
    reason: 'normal operation',
    actor: 'system',
    evidence: 'N/A',
    ...overrides,
  };
}

/** Mock fetch that responds to the kill-switch state and report endpoints. */
function makeMock({ getToken, status = 200 }) {
  return createMockFetch((req) => {
    if (req.url.includes('/api/v1/killswitch/state')) {
      if (status !== 200) return { status };
      return { status: 200, body: { token: getToken(), claims: {}, server_time: 0 } };
    }
    if (req.url.includes('/api/v1/killswitch/report')) {
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });
}

function makeManager({ mock, now, extra = {} }) {
  return new KillSwitchManager({
    tenant: TENANT,
    agent: AGENT,
    baseUrl: 'http://127.0.0.1:8787',
    apiKey: 'test-api-key',
    allowedAlgorithms: ['HS256'],
    pinnedKeys: { [KID]: { kty: 'oct', k: SECRET_B64U } },
    fetchImpl: mock.fetch,
    ...(now ? { now } : {}),
    ...extra,
  });
}

// --- Local halt: the panic button works with no network at all ---

test('haltLocal sets HALTED immediately without a network call', async () => {
  const mock = makeMock({ getToken: () => buildSignedToken(baseClaims()) });
  const manager = makeManager({ mock });
  const status = await manager.haltLocal('panic button', 'INC-1');
  assert.equal(status.halted, true);
  assert.equal(status.origin, 'local');
  assert.equal(status.verified, false);
  assert.equal(manager.halted, true);
});

test('enforce throws KillSwitchHaltedError when locally halted', async () => {
  const mock = makeMock({ getToken: () => buildSignedToken(baseClaims()) });
  const manager = makeManager({ mock });
  await manager.haltLocal('panic');
  await assert.rejects(() => manager.enforce(), KillSwitchHaltedError);
});

// --- Fail-closed posture ---

test('enforce fails closed when the control plane is unreachable', async () => {
  const mock = makeMock({ getToken: () => '', status: 500 });
  const manager = makeManager({ mock });
  await assert.rejects(() => manager.enforce(), KillSwitchHaltedError);
});

test('enforce passes with a valid signed RUNNING state', async () => {
  const token = buildSignedToken(baseClaims({ state: 'RUNNING' }));
  const mock = makeMock({ getToken: () => token });
  const manager = makeManager({ mock });
  const status = await manager.enforce();
  assert.equal(status.halted, false);
  assert.equal(status.verified, true);
  assert.equal(status.origin, 'control-plane');
});

test('enforce throws with a valid signed HALTED state', async () => {
  const token = buildSignedToken(baseClaims({ state: 'HALTED', reason: 'global halt' }));
  const mock = makeMock({ getToken: () => token });
  const manager = makeManager({ mock });
  await assert.rejects(
    () => manager.enforce(),
    (err) => err instanceof KillSwitchHaltedError && /global halt/.test(err.message),
  );
});

// --- Local resume: requires a newer verified state, or break-glass ---

test('resumeLocal without a newer verified state is refused', async () => {
  const token = buildSignedToken(baseClaims({ epoch: 5 }));
  const mock = makeMock({ getToken: () => token });
  const manager = makeManager({ mock });
  await manager.haltLocal('operator');
  await assert.rejects(
    () => manager.resumeLocal({ reason: 'clear' }),
    KillSwitchLocalHaltError,
  );
});

test('resumeLocal with break-glass clears the local halt', async () => {
  const mock = makeMock({ getToken: () => buildSignedToken(baseClaims()) });
  const manager = makeManager({ mock });
  await manager.haltLocal('operator');
  assert.equal(manager.halted, true);
  const status = await manager.resumeLocal({ reason: 'cleared by operator', breakGlass: true });
  assert.equal(status.halted, false);
  assert.equal(manager.halted, false);
});

test('resumeLocal with break-glass requires a non-empty reason', async () => {
  const mock = makeMock({ getToken: () => buildSignedToken(baseClaims()) });
  const manager = makeManager({ mock });
  await manager.haltLocal('operator');
  await assert.rejects(
    () => manager.resumeLocal({ reason: '   ', breakGlass: true }),
    KillSwitchLocalHaltError,
  );
});

// --- Fast path: refresh: false ---

test('enforce({ refresh: false }) without a cached state throws', async () => {
  const mock = makeMock({ getToken: () => buildSignedToken(baseClaims()) });
  const manager = makeManager({ mock });
  await assert.rejects(
    () => manager.enforce({ refresh: false }),
    KillSwitchUnavailableError,
  );
});

test('enforce({ refresh: false }) uses the cached state without a network call', async () => {
  const token = buildSignedToken(baseClaims());
  const mock = makeMock({ getToken: () => token });
  const manager = makeManager({ mock });
  await manager.enforce();
  const before = mock.calls.length;
  await manager.enforce({ refresh: false });
  assert.equal(mock.calls.length, before, 'no additional network call');
});

// --- Anti-rollback: a lower epoch is refused ---

test('a RUNNING token with a lower epoch is rejected (anti-rollback)', async () => {
  let clock = 1000;
  let currentEpoch = 5;
  const mock = createMockFetch((req) => {
    if (req.url.includes('/api/v1/killswitch/state')) {
      return {
        status: 200,
        body: { token: buildSignedToken(baseClaims({ epoch: currentEpoch })), claims: {}, server_time: 0 },
      };
    }
    return { status: 404 };
  });
  const manager = makeManager({ mock, now: () => clock, extra: { maxStaleSeconds: 0 } });

  // First enforce: epoch 5 RUNNING is accepted.
  await manager.enforce();

  // Advance time so the cached state is considered stale, and present an older epoch.
  clock = 1001;
  currentEpoch = 3;

  await assert.rejects(() => manager.enforce(), KillSwitchHaltedError);
});

// --- Local audit trail ---

test('the local audit trail verifies after a series of operations', async () => {
  const mock = makeMock({ getToken: () => buildSignedToken(baseClaims()) });
  const manager = makeManager({ mock });
  await manager.enforce();
  await manager.haltLocal('operator');
  // Give the fire-and-forget report a tick to complete.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const audit = await manager.verifyAuditTrail();
  assert.equal(audit.valid, true);
  assert.ok(audit.length >= 2, `expected at least 2 audit entries, got ${audit.length}`);
});
