
# @anterislab/guard

Runtime guard for autonomous agents: every action is evaluated **before** it executes, and a
stop order actually stops the agent.

Zero runtime dependencies. Node 20+.

## Requirements

AnterisLab Guard is the open-source client SDK for the AnterisLab policy engine. It requires an
active AnterisLab subscription to function. A 14-day free tier is available for evaluation.

The policy engine and kill switch run in the AnterisLab cloud. This SDK provides the client side:
enforcement, transport, verdict verification, and kill switch coordination.

## Installation

```bash
npm install @anterislab/guard
```

## Minimal usage

```js
import { Guard, GuardBlockedError } from '@anterislab/guard';

const guard = new Guard({ apiKey: process.env.ANTERISLAB_API_KEY });

const charge = guard.wrapFn(paymentAgent.charge, {
  agent: 'billing-bot',
  toAction: (amount) => ({ type: 'payment', amount, currency: 'EUR' }),
});

try {
  await charge(4200);        // if the gate denies, charge() is NOT invoked
} catch (error) {
  if (error instanceof GuardBlockedError) {
    console.error('action denied:', error.message);
  }
}
```

## Full coverage: `wrap()`

`wrap()` protects **every** method on the object. Exceptions are declared one by one:

```js
const safe = guard.wrap(agent, { agent: 'billing-bot', passthrough: ['describe'] });
await safe.charge(10);     // evaluated
await safe.refund(10);     // evaluated
safe.describe();           // passthrough, explicitly declared
```

## Kill switch

```js
const guard = new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
  killSwitch: { tenant: 'acme', agent: 'billing-bot', baseUrl, apiKey },
});

await guard.halt('incident in progress', 'INC-1234');   // stops NOW, no round-trip
await guard.status();
await guard.resume({ reason: 'incident resolved', evidence: 'INC-1234' });

const stop = await guard.startStream();   // halt via SSE in milliseconds
```

With `maxStaleSeconds: 0` the client revalidates state on every action; with the default (90 s) it
reduces round-trips and relies on server-side enforcement as a second layer.

## Signed verdicts

```js
new Guard({ apiKey, verifyVerdict: process.env.ANTERISLAB_VERDICT_SECRET });
```

When `verifyVerdict` is configured, an unsigned positive verdict is **rejected**. The signature
covers the exact response body.

## Testing without a subscription

Development and tests do not need a subscription or a live control plane. Import the
public mock from the `/mock` subpath:

```js
import { Guard } from '@anterislab/guard';
import { createMockFetch, approvedVerdict, blockedVerdict } from '@anterislab/guard/mock';

const mock = createMockFetch({ status: 200, body: approvedVerdict() });
const guard = new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch });

// ... run your guarded code ...

mock.evaluateCalls;   // number of calls to /api/v1/evaluate
mock.calls;           // full request log (url, method, headers, body)
mock.reset();         // clear the log and restart the responder sequence
```

The responder can be:

- a **single route** — the same response for every call;
- an **array of routes** — successive responses, the last one repeats;
- a **function** — receives each request and returns a route, useful for
  kill-switch tests where different URLs return different shapes.

Use `signBody(secret, rawBody)` to produce an HMAC-SHA256 signature in the
format `verifyVerdict` expects. The mock never performs a network call and
contains no production logic.

## Options

| Option | Default | Description |
|---|---|---|
| `apiKey` | — | **Required.** Never appears in URLs, bodies, or error messages. |
| `baseUrl` | `https://www.anterislab.com` | Control plane origin. Must be listed in `allowedHosts`. |
| `allowedHosts` | `anterislab.com`, `www.anterislab.com` | Hosts the key is allowed to travel to. |
| `allowInsecureHttp` | `false` | Allows `http://` **only** on loopback, for development. |
| `timeoutMs` | `5000` | Covers the entire transaction, including body reads. |
| `retries` | `1` | Only on transport failures and 5xx. Never on 401/402/403/409. |
| `maxRetryAfterMs` | `30000` | Maximum delay honored from a `Retry-After`. Beyond that: reject. |
| `failOpen` | `false` | If the guard is unreachable, proceeds and records `UNAVAILABLE`. **Never raises a real `APPROVED` and never bypasses a 402.** |
| `verifyVerdict` | — | HMAC secret or custom verifier `(body, signature) => boolean`. |
| `idempotency` | `true` | `Idempotency-Key` per action, reused across retries. |
| `expectedAgent` | — | Pins the client to a single agent identity. |
| `onDecision` | — | Telemetry on every verdict. Cannot change the outcome. |
| `onPaused` | — | **Notification.** If it resolves, rejects, or throws, the action does not run. |

## Errors

| Class | `code` | What to do |
|---|---|---|
| `GuardBlockedError` | `GUARD_BLOCKED` | The policy denied the action. Do not retry: it is a decision. |
| `GuardPausedError` | `GUARD_PAUSED` | Human review required. Notify and stop. |
| `GuardHaltedError` | `GUARD_HALTED` | Kill switch is active. Wait for resume. |
| `GuardQuotaError` | `GUARD_QUOTA_EXCEEDED` | Quota exhausted (`402`). **Terminal.** Upgrade your plan. |
| `GuardAuthError` | `GUARD_UNAUTHORIZED` (401) / `GUARD_FORBIDDEN` (403) | Credential or perimeter. |
| `GuardPolicyError` | `GUARD_STALE_POLICY` | `409`, e.g. mismatched `expected_epoch`. |
| `GuardUnavailableError` | `GUARD_UNAVAILABLE` | Guard unreachable. Fail-closed. |
| `GuardConfigError` | `GUARD_CONFIG` | Configuration that would weaken guarantees. |
| `GuardStateInvalidError` | `GUARD_STATE_INVALID` | Kill switch state too stale. |

## Guarantees

1. An unrecognized verdict **does not authorize** (positive allow-list, fail-closed).
2. `wrap()` covers every method: the error for omission is closed.
3. `PAUSED` blocks whatever the hook does.
4. The timeout covers body reads too and does not depend on `fetch`'s `signal`.
5. `402`, `401`, `403`, `409` are terminal: never retried.
6. The API key never appears in URLs, bodies, or logs.
7. A halt arriving during evaluation still stops the action (anti-TOCTOU).

## Documentation

Full documentation lives in [`docs/`](docs/README.md):

- **[Quick start](docs/quick-start.md)** — install and run your first guarded action.
- **[Configuration](docs/configuration.md)** — every option `new Guard(...)` to accepts.
- **[Verdict reacts](docs/verdicts.
.md)** —- what `APPROVED`, `FLAGGED`, `BLOCKED`, and `PAUSED` mean.
- **[Error handling](docs/error-handling.md)** — the `GuardError` hierarchy and how **[Kill switch](docs/kill-switch.md)** — local halt, verified state, SSE stream.
- **[Testing](docs/testing.md)** — the public mock, and testing without a subscription.
- **[Subscription](docs/subscription.md)** — free tier, expiry, and upgrading.
- **[Security model](docs/security-model.md)** — what the SDK protects against, and what it does not.
- **[API reference](docs/api-reference.md)** — the complete public surface.

For vulnerability reporting, see [SECURITY.md](SECURITY.md).
For contributing, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
