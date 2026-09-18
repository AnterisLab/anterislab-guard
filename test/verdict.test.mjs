/**
 * Verdetto: la garanzia che una risposta non riconosciuta NON autorizza.
 * Questi test sono la prova ri-eseguibile del difetto C-01/C-02 della 0.1.1.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Guard, GuardBlockedError } from './imports.mjs';
import { makeFetch, makeAgent, approved } from './helpers.mjs';

// Nota didattica: `allowedHosts` va dichiarato anche per lo sviluppo locale. Il vincolo non
// "si allenta" da solo perche' l'host e' loopback: la chiave va autorizzata verso un host, sempre.
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

// --- La controprova: APPROVED esegue, altrimenti i test sotto non provano nulla ---
test('APPROVED esegue l\'azione (controllo positivo)', async () => {
  const { error, effects } = await runWith(approved());
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

// --- Il difetto storico: lo schema DOCUMENTATO {verdict:"block"} deve bloccare ---
test('schema documentato {verdict:"block"} blocca (PoC v15)', async () => {
  const { error, effects } = await runWith({ verdict: 'block', reason: 'limite pagamenti', policy: 'Payment limit' });
  assert.ok(error instanceof GuardBlockedError, 'atteso GuardBlockedError');
  assert.deepEqual(effects, [], 'nessun effetto collaterale');
});

test('decision BLOCKED blocca', async () => {
  const { error, effects } = await runWith({ decision: 'BLOCKED', reason: 'negato' });
  assert.ok(error instanceof GuardBlockedError);
  assert.deepEqual(effects, []);
});

test('decision FLAGGED esegue (autorizzante)', async () => {
  const { error, effects } = await runWith({ decision: 'FLAGGED' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

// --- Corpi ostili: 21 varianti, tutte devono negare ---
const HOSTILE = [
  ['oggetto vuoto', {}],
  ['null', null],
  ['array', []],
  ['stringa', 'APPROVED'],
  ['numero', 200],
  ['decision null', { decision: null }],
  ['decision stringa vuota', { decision: '' }],
  ['decision spazi', { decision: '   ' }],
  ['parola sconosciuta', { decision: 'YES_PLEASE' }],
  ['UNAVAILABLE dal server', { decision: 'UNAVAILABLE' }],
  ['decision booleano', { decision: true }],
  ['decision oggetto', { decision: { ok: true } }],
  ['verdict sconosciuto', { verdict: 'maybe' }],
  ['solo reason', { reason: 'ok' }],
  ['policy senza verdetto', { policy: 'P-1' }],
  ['error envelope annidato', { error: { code: 'internal_error' } }],
  ['conflitto APPROVED/BLOCKED', { decision: 'APPROVED', verdict: 'blocked' }],
  ['conflitto BLOCKED/approved', { decision: 'BLOCKED', verdict: 'approved' }],
];

for (const [name, body] of HOSTILE) {
  test(`corpo ostile: ${name} -> nessun effetto`, async () => {
    const { error, effects } = await runWith(body);
    assert.ok(error instanceof GuardBlockedError, `atteso diniego per ${name}, ricevuto ${error}`);
    assert.deepEqual(effects, [], `nessun effetto per ${name}`);
  });
}

test('alias legacy minuscolo `allow` esegue (compatibilita contratto v17 R2)', async () => {
  // Deliberato: gli alias sono accettati per non rompere i client 0.1.x durante il rilascio
  // coordinato. Il backend DEVE comunque emettere `decision` canonico. Questo test fissa il
  // comportamento, cosi' un cambio di idea e' una decisione visibile e non una regressione muta.
  const { error, effects } = await runWith({ decision: 'allow' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

test('schema legacy {verdict:"approve"} esegue', async () => {
  const { error, effects } = await runWith({ verdict: 'approve' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

test('con expectedAgent impostato, un agente disallineato viene negato', async () => {
  const { error, effects } = await runWith({ decision: 'APPROVED', agent: 'altro-agente' }, { expectedAgent: 'billing-bot' });
  assert.ok(error instanceof GuardBlockedError);
  assert.deepEqual(effects, []);
});

test('senza expectedAgent la pinning dell agente non e attiva (opt-in)', async () => {
  const { error, effects } = await runWith({ decision: 'APPROVED', agent: 'altro-agente' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

test('latency_ms non numerica non blocca: e telemetria, non autorizzazione', async () => {
  const { error, effects } = await runWith({ decision: 'APPROVED', latency_ms: 'veloce' });
  assert.equal(error, null);
  assert.deepEqual(effects, ['charge:4200']);
});

test('request per un agente diverso da expectedAgent viene negata prima della rete', async () => {
  const { impl, calls } = makeFetch({ status: 200, body: approved() });
  const guard = new Guard({ ...BASE, fetchImpl: impl, expectedAgent: 'billing-bot' });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'altro-agente', toAction: (a) => ({ type: 'payment', amount: a }) });
  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, []);
  assert.equal(calls.evaluate, 0, 'nessuna chiamata di rete: il vincolo e locale');
});

test('corpo HTML di un captive portal -> diniego', async () => {
  const { impl } = makeFetch({ status: 200, raw: '<html><body>Accedi al WiFi</body></html>' });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });
  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, []);
});

test('JSON troncato -> diniego', async () => {
  const { impl } = makeFetch({ status: 200, raw: '{"decision":"APPRO' });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });
  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, []);
});
