
# Testing

Development and tests do not need a subscription and do not touch the
network. The SDK ships with a public mock, available via the `/mock` subpath,
that returns any response you need and records every call.

This guide shows the recommended patterns. For the full mock API, see
[api-reference.md](api-reference.md#mock-module).

## Why the mock exists

An SDK that can only be tested against a paid control plane is hard to adopt:
CI would need credentials, contributors would need a subscription, and examples
in the docs would not run. The mock solves that. It is zero-dependency,
deterministic, and contains no production logic.

The SDK's own test suite uses the same public mock. If the mock were not good
enough for our tests, it would not be good enough for yours.

## Try it in 30 seconds (no signup)

If you want to test against the real control plane before committing to a
subscription, use the public sandbox key:

```js
import { Guard, GuardBlockedError } from '@anterislab/guard';

const guard = new Guard({ apiKey: 'anteris_sandbox_public' });

try {
  await guard.decide(
    { type: 'payment', amount: 250, currency: 'EUR' },
    'billing-bot',
  );
} catch (error) {
  if (error instanceof GuardBlockedError) {
    console.log('blocked:', error.message);
  }
}
```

The sandbox is a **real** evaluation against a **small set of demonstration
policies**. It is not a mock: the SDK sends a real HTTP request, receives a
real verdict, and applies all the usual safeguards (fail-closed posture, verdict
parsing, signature handling if configured).

What the sandbox does:

- Returns `APPROVED` for anything that matches no rule.
- Returns `BLOCKED` for `amount > 100` on any action that carries a numeric
  `amount` in its context.
- Returns `PAUSED` for a `domain` in `['unknown.example', 'suspicious.tld',
  'malware.test']`.
- Rate-limits at **20 evaluations per minute per IP**.

What the sandbox does **not** do:

- It does not touch a database, a tenant, or a quota.
- It does not consume plan limits.
- It does not store anything. Nothing you send to the sandbox is persisted.
- It does not sign verdicts. Do not configure `verifyVerdict` when pointing at
  the sandbox.

Try all three outcomes with `curl`:

```bash
# APPROVED
curl -X POST https://www.anterislab.com/api/v1/evaluate \
  -H "Authorization: Bearer anteris_sandbox_public" \
  -H "content-type: application/json" \
  -d '{"agent":"test-bot","action":"read.data"}'

# BLOCKED (amount > 100)
curl -X POST https://www.anterislab.com/api/v1/evaluate \
  -H "Authorization: Bearer anteris_sandbox_public" \
  -H "content-type: application/json" \
  -d '{"agent":"billing-bot","action":{"type":"payment","amount":250}}'

# PAUSED (risky domain)
curl -X POST https://www.anterislab.com/api/v1/evaluate \
  -H "Authorization: Bearer anteris_sandbox_public" \
  -H "content-type: application/json" \
  -d '{"agent":"net-bot","action":"fetch","context":{"domain":"unknown.example"}}'
```

The sandbox is designed to be safe by construction: the key is public, the
engine is hardcoded, the rate limit is per IP, and the branch does not open a
connection to the production database. It is a teaching tool, not a production
gateway.
## Basic setup

```js
import { Guard } from '@anterislab/guard';
import { createMockFetch, approvedVerdict } from '@anterislab/guard/mock';

const mock = createMockFetch({ status: 200, body: approvedVerdict() });
const guard = new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch });
```

From this point on, every call the SDK would make to `/api/v1/evaluate` is
served by the mock. No network, no credentials, no subscription.

## Testing a wrapped function

The most common pattern: build a real `Guard` with a mock, wrap a function
whose side effects you care about, and count the effects.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guard, GuardBlockedError } from '@anterislab/guard';
import { createMockFetch, approvedVerdict } from '@anterislab/guard/mock';

test('a denied action produces no side effect', async () => {
  const mock = createMockFetch({
    status: 200,
    body: { decision: 'BLOCKED', reason: 'test denial' },
  });
  const guard = new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch });

  const effects = [];
  const safeCharge = guard.wrapFn(
    async (amount) => {
      effects.push(amount);
    },
    {
      agent: 'test-agent',
      toAction: (amount) => ({ type: 'payment', amount }),
    },
  );

  await assert.rejects(() => safeCharge(4200), GuardBlockedError);
  assert.deepEqual(effects, [], 'the side effect did not run');
});
```

The assertion on `effects` is the important one. *"It did not throw"* is
weaker evidence than *"nothing happened"* — the SDK's own tests follow the
same rule.

## Building verdicts

The mock exports four builders that produce canonical verdict bodies:

```js
import {
  approvedVerdict,
  flaggedVerdict,
  blockedVerdict,
  pausedVerdict,
} from '@anterislab/guard/mock';

approvedVerdict();                    // { decision: 'APPROVED', ... }
flaggedVerdict('under review');       // { decision: 'FLAGGED', ... }
blockedVerdict('over limit');         // { decision: 'BLOCKED', ... }
pausedVerdict('manual review');       // { decision: 'PAUSED', ... }
```

Each accepts an optional `extra` object that is merged into the body:

```js
approvedVerdict('billing-bot', { latency_ms: 8, decision_id: 'd-8' });
```

## Responder forms

The responder can be:

- **A single route** — the same response for every call.
- **An array of routes** — successive responses; the last one repeats.
- **A function** — receives each request and returns a route.

### Single route

```js
const mock = createMockFetch({ status: 200, body: approvedVerdict() });
```

### Array of routes

Useful to test retry behavior:

```js
const mock = createMockFetch([
  { status: 503 },                       // first attempt fails
  { status: 200, body: approvedVerdict() }, // second succeeds
]);

const guard = new Guard({ apiKey, fetchImpl: mock.fetch, retries: 1 });
// The wrapped action succeeds on the second attempt.
```

### Function responder

Useful when different URLs return different shapes (for example, mixing
`/evaluate` and kill-switch endpoints):

```js
const mock = createMockFetch((req) => {
  if (req.url.includes('/api/v1/killswitch/state')) {
    return { status: 200, body: { token: 'signed-token', claims: {}, server_time: 0 } };
  }
  return { status: 200, body: approvedVerdict() };
});
```

## Testing signed verdicts

When `verifyVerdict` is configured, the SDK expects an HMAC signature on the
verdict body. Use `signBody` to produce one in the format the SDK checks.

```js
import { createMockFetch, approvedVerdict, signBody } from '@anterislab/guard/mock';

const SECRET = 'shared-secret-at-least-16-chars';
const body = JSON.stringify(approvedVerdict());

const mock = createMockFetch({
  status: 200,
  raw: body,
  headers: {
    'x-anterislab-signature': signBody(SECRET, body),
  },
});

const guard = new Guard({
  apiKey: 'test-key',
  fetchImpl: mock.fetch,
  verifyVerdict: SECRET,
});
```

### Testing that an unsigned verdict is refused

```js
const mock = createMockFetch({ status: 200, raw: JSON.stringify(approvedVerdict()) });
const guard = new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch, verifyVerdict: SECRET });

await assert.rejects(() => safeCharge(1), GuardBlockedError);
// An unsigned APPROVED does not authorize.
```

## Testing malformed responses

Use `raw` to return a body that is not valid JSON, or is a JSON value of the
wrong shape.

```js
// HTML from a captive portal
createMockFetch({ status: 200, raw: '<html>Sign in to WiFi</html>' });

// Truncated JSON
createMockFetch({ status: 200, raw: '{"decision":"APPRO' });

// A verdict that is not a string
createMockFetch({ status: 200, body: { decision: { ok: true } } });

// The client-reserved word
createMockFetch({ status: 200, body: { decision: 'UNAVAILABLE' } });
```

All of these should produce a denial. Testing them is how you confirm the SDK
is not accidentally permissive.

## Testing the kill switch

The kill switch is a paid feature and requires signed tokens. In tests, the
simplest way to exercise the full pipeline is HS256 with a pinned key. This is
the same approach the SDK's own tests use.

```js
import { createHmac } from 'node:crypto';
import { KillSwitchManager } from '@anterislab/guard';
import { createMockFetch } from '@anterislab/guard/mock';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 bytes
const SECRET_B64U = SECRET.toString('base64url');
const KID = 'test-kid';

function b64u(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function signedToken(claims) {
  const header = { alg: 'HS256', kid: KID, typ: 'anterislab-killswitch+jws', v: 1 };
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(claims));
  const signingInput = `${h}.${p}`;
  const sig = createHmac('sha256', SECRET).update(signingInput).digest();
  return `${signingInput}.${b64u(sig)}`;
}

const now = Math.floor(Date.now() / 1000);
const token = signedToken({
  iss: 'anterislab',
  aud: 'anterislab-guard',
  sub: 'test-tenant',
  iat: now,
  nbf: now - 1,
  exp: now + 60,
  jti: 'jti-1',
  epoch: 1,
  state: 'RUNNING',
  scope: { tenant: 'test-tenant', agent: 'test-agent' },
  reason: 'normal operation',
  actor: 'system',
  evidence: 'N/A',
});

const mock = createMockFetch((req) => {
  if (req.url.includes('/api/v1/killswitch/state')) {
    return { status: 200, body: { token, claims: {}, server_time: 0 } };
  }
  return { status: 200, body: { ok: true } };
});

const manager = new KillSwitchManager({
  tenant: 'test-tenant',
  agent: 'test-agent',
  baseUrl: 'http://127.0.0.1:8787',
  apiKey: 'test-key',
  allowedAlgorithms: ['HS256'],
  pinnedKeys: { [KID]: { kty: 'oct', k: SECRET_B64U } },
  fetchImpl: mock.fetch,
});
```

Production uses EdDSA by default. HS256 is opt-in via `allowedAlgorithms` and
is intended for single-process self-hosting and tests. The verification
pipeline — JWS structure, claim rules, epoch, scope — is identical for both.

## Mock limitations

- **No SSE.** `startStream()` is not simulated. Testing it requires a custom
  `ReadableStream`; if you need it, open a discussion.
- **No JWKS fetching.** `/well-known/anterislab-jwks.json` is not served
  automatically. Use `pinnedKeys` or the `jwks` option to inject keys
  directly.
- **No timing simulation** beyond `delayMs`. For time-dependent behavior, use
  the `now` option on `KillSwitchManager`.

## Recording calls

`mock.calls` is an ordered array of every request:

```js
mock.calls[0];
// {
//   url: 'https://www.anterislab.com/api/v1/evaluate',
//   method: 'POST',
//   headers: { 'content-type': 'application/json', authorization: 'Bearer test-key', ... },
//   body: '{"agent":"test-agent","action":{...}}',
// }
```

Convenience accessors:

- `mock.evaluateCalls` — count of calls whose URL contains `/api/v1/evaluate`.
- `mock.reset()` — clear `calls` and restart the responder sequence.

## Best practices

- **Test the effect, not the exception.** Assert that the wrapped function did
  *not* run, not just that it threw.
- **Use the array responder to test retries.** This is the only reliable way
  to exercise the retry budget.
- **Test the hostile cases.** Malformed JSON, wrong types, conflicts between
  `decision` and `verdict`. The SDK is fail-closed by construction, and the
  tests should prove it.
- **Do not mock the SDK itself.** Mock the network, use a real `Guard`. The
  whole point of the SDK is its behavior; mocking it defeats the test.
- **Reuse the same `mock` across assertions in a test,** and call `reset()`
  between tests. The call log is a useful debugging aid when a test fails.

## See also

- [Quick start](quick-start.md) — a minimal example using the mock.
- [API reference](api-reference.md#mock-module) — the complete mock surface.
- [Kill switch](kill-switch.md) — the module the kill-switch tests exercise.
