/**
 * Enforcement: la garanzia che l'azione NON venga eseguita quando non deve.
 * Ogni test conta gli EFFETTI collaterali reali prodotti dall'agente strumentato, perche'
 * "non ha sollevato" e' una prova piu' debole di "non e' successo niente".
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

// --- Copertura: wrap() protegge TUTTI i metodi, non solo il primo ---
test('wrap() intercetta ogni metodo, non uno solo (difetto A-01)', async () => {
  const { impl } = makeFetch({ status: 200, body: { decision: 'BLOCKED', reason: 'negato' } });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrap(agent, { agent: 'billing-bot' });

  await assert.rejects(() => safe.charge(10), GuardBlockedError);
  await assert.rejects(() => safe.refund(10), GuardBlockedError);

  assert.deepEqual(effects, [], 'nessuno dei due metodi ha prodotto effetti');
});

test('passthrough esplicito salta il gate solo per i metodi dichiarati', async () => {
  const { impl } = makeFetch({ status: 200, body: { decision: 'BLOCKED', reason: 'negato' } });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrap(agent, { agent: 'billing-bot', passthrough: ['describe'] });

  assert.equal(safe.describe(), 'agent strumentato', 'describe e\' passante');
  await assert.rejects(() => safe.charge(10), GuardBlockedError);
  assert.deepEqual(effects, []);
});

test('con APPROVED entrambi i metodi eseguono (controllo positivo)', async () => {
  const { impl } = makeFetch({ status: 200, body: approved() });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  const { agent, effects } = makeAgent();
  const safe = guard.wrap(agent, { agent: 'billing-bot' });

  await safe.charge(10);
  await safe.refund(20);
  assert.deepEqual(effects, ['charge:10', 'refund:20']);
});

// --- PAUSED e' sempre bloccante, qualunque cosa faccia l'hook ---
for (const hookCase of ['risolve', 'rigetta', 'solleva']) {
  test(`PAUSED blocca anche quando onPaused ${hookCase}`, async () => {
    const { impl } = makeFetch({ status: 200, body: { decision: 'PAUSED', reason: 'serve revisione', decision_id: 'd-9' } });
    let hookCalls = 0;
    const onPaused = async () => {
      hookCalls += 1;
      if (hookCase === 'rigetta') throw new Error('reviewer non raggiungibile');
      if (hookCase === 'solleva') throw new Error('boom');
    };
    const guard = new Guard({ ...BASE, fetchImpl: impl, onPaused });
    const { agent, effects } = makeAgent();
    const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

    await assert.rejects(() => safe(5000), GuardPausedError);
    assert.equal(hookCalls, 1, 'l hook e\' stato notificato');
    assert.deepEqual(effects, [], 'l hook NON ha autorizzato nulla');
  });
}

test('onDecision e\' invocato ma non puo\' cambiare l\'esito', async () => {
  const { impl } = makeFetch({ status: 200, body: { decision: 'BLOCKED', reason: 'no' } });
  const seen = [];
  const guard = new Guard({
    ...BASE,
    fetchImpl: impl,
    onDecision: (decision) => { seen.push(decision.decision); throw new Error('telemetria rotta'); },
  });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

  await assert.rejects(() => safe(1), GuardBlockedError);
  assert.deepEqual(seen, ['BLOCKED']);
  assert.deepEqual(effects, []);
});

// --- Firma del verdetto ---
const SECRET = 'segreto-condiviso-lungo-abbastanza';

test('con verifyVerdict, un verdetto APPROVED non firmato viene negato', async () => {
  const body = JSON.stringify(approved());
  const { impl } = makeFetch({ status: 200, raw: body });
  const guard = new Guard({ ...BASE, fetchImpl: impl, verifyVerdict: SECRET });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, [], 'un APPROVED non autentico non autorizza');
});

test('con verifyVerdict, una firma valida fa passare l\'azione', async () => {
  const body = JSON.stringify(approved());
  const { impl } = makeFetch({ status: 200, raw: body, headers: { 'x-anterislab-signature': signBody(SECRET, body) } });
  const guard = new Guard({ ...BASE, fetchImpl: impl, verifyVerdict: SECRET });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

  await safe(10);
  assert.deepEqual(effects, ['charge:10']);
});

test('una firma valida su un corpo DIVERSO non autorizza', async () => {
  const body = JSON.stringify(approved());
  const { impl } = makeFetch({ status: 200, raw: body, headers: { 'x-anterislab-signature': signBody(SECRET, body + ' ') } });
  const guard = new Guard({ ...BASE, fetchImpl: impl, verifyVerdict: SECRET });
  const { agent, effects } = makeAgent();
  const safe = guard.wrapFn(agent.charge, { agent: 'billing-bot', toAction: (a) => ({ type: 'payment', amount: a }) });

  await assert.rejects(() => safe(10), GuardBlockedError);
  assert.deepEqual(effects, []);
});

// --- Configurazione che indebolirebbe le garanzie: rifiutata alla costruzione ---
test('baseUrl http:// non-loopback viene rifiutato alla costruzione', () => {
  assert.throws(
    () => new Guard({ ...BASE, baseUrl: 'http://evil.example', allowedHosts: ['evil.example'] }),
    GuardConfigError,
  );
});

test('un host non in allowedHosts viene rifiutato', () => {
  assert.throws(() => new Guard({ ...BASE, baseUrl: 'https://evil.example' }), GuardConfigError);
});

test('senza apiKey il costruttore rifiuta', () => {
  assert.throws(() => new Guard({ ...BASE, apiKey: '' }), GuardConfigError);
});

test('http:// su loopback e\' permesso solo con allowInsecureHttp', () => {
  assert.throws(() => new Guard({ ...BASE, allowInsecureHttp: false }), GuardConfigError);
});

test('un segreto di firma troppo corto viene rifiutato', () => {
  assert.throws(() => new Guard({ ...BASE, verifyVerdict: 'corto' }), GuardConfigError);
});

test('killSwitch assente: halt() lo dice esplicitamente invece di fingere', async () => {
  const { impl } = makeFetch({ status: 200, body: approved() });
  const guard = new Guard({ ...BASE, fetchImpl: impl });
  await assert.rejects(() => guard.halt('test'), GuardConfigError);
});
