
# Quick start

This guide gets you from zero to a guarded action in a few minutes. You do not
need a subscription to follow the first section: the SDK ships with a public
mock for local development and tests.

## Requirements

- Node.js 18 or later.
- npm, pnpm, or yarn.

AnterisLab Guard has zero runtime dependencies.

## Install

```bash
npm install @anterislab/guard
```

## Step 1 — Your first guarded action, without a subscription

Use the public mock to run a guarded action with no network and no credentials:

```js
import { Guard, GuardBlockedError } from '@anterislab/guard';
import { createMockFetch, approvedVerdict } from '@anterislab/guard/mock';

const mock = createMockFetch({ status: 200, body: approvedVerdict() });
const guard = new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch });

const safeCharge = guard.wrapFn(
  async (amount) => {
    console.log(`charging ${amount}`);
    return 'ok';
  },
  {
    agent: 'billing-bot',
    toAction: (amount) => ({ type: 'payment', amount, currency: 'EUR' }),
  },
);

await safeCharge(4200);     // the action is evaluated, then executed
console.log(mock.evaluateCalls);   // 1
```

Now change the mock to deny the action and run it again:

```js
const mock = createMockFetch({ status: 200, body: { decision: 'BLOCKED', reason: 'payment limit' } });
const guard = new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch });

try {
  await safeCharge(4200);
} catch (error) {
  if (error instanceof GuardBlockedError) {
    console.log('denied:', error.message);
    // "charging 4200" was never printed: the side effect did not happen.
  }
}
```

This is the core promise of AnterisLab Guard: if the gate denies, the wrapped
function is not invoked.

For the full mock API, see [testing.md](testing.md).

## Step 2 — Connect to the control plane

To evaluate actions against your real policies, you need a subscription
(see [subscription.md](subscription.md)) and an API key from the AnterisLab
dashboard.

```js
import { Guard } from '@anterislab/guard';

const guard = new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
});

const safeRefund = guard.wrapFn(
  async (amount) => refundService.process(amount),
  {
    agent: 'billing-bot',
    toAction: (amount) => ({ type: 'refund', amount, currency: 'EUR' }),
  },
);

await safeRefund(10);
```

The SDK sends the action to `/api/v1/evaluate` on the AnterisLab control plane,
which evaluates it against your policies and returns a verdict.

Do not hardcode the API key. Read it from an environment variable or a secret
manager.

## Step 3 — Wrap an entire object

`wrapFn` protects a single function. `wrap` protects **every method** of an
object, and you declare exceptions one by one:

```js
const safeAgent = guard.wrap(paymentAgent, {
  agent: 'billing-bot',
  passthrough: ['describe'],   // this method skips the gate
});

await safeAgent.charge(10);    // evaluated
await safeAgent.refund(10);    // evaluated
safeAgent.describe();          // passthrough
```

If you forget to declare a method as `passthrough`, it will be evaluated. This
is deliberate: the default is to protect, and to opt out you must say so
explicitly.

## Step 4 — Handle errors

Every error thrown by the SDK extends `GuardError`. A single `catch` can
distinguish between a policy denial, a quota exhaustion, an authentication
failure, and an unreachable guard:

```js
import {
  GuardError,
  GuardBlockedError,
  GuardQuotaError,
  GuardAuthError,
  GuardUnavailableError,
} from '@anterislab/guard';

try {
  await safeCharge(4200);
} catch (error) {
  if (error instanceof GuardBlockedError) {
    // The policy denied. Do not retry: it is a decision.
  } else if (error instanceof GuardQuotaError) {
    // Plan quota exhausted. Upgrade your plan.
  } else if (error instanceof GuardAuthError) {
    // Invalid key or agent out of scope.
  } else if (error instanceof GuardUnavailableError) {
    // The guard is unreachable. Fail-closed by default.
  } else if (error instanceof GuardError) {
    // Any other guard error. `error.code` is stable for logging and metrics.
  }
}
```

See [error-handling.md](error-handling.md) for the full hierarchy and the
recommended reaction for each class.

## What to do next

- **[Configuration](configuration.md)** — every option `new Guard(...)` accepts.
- **[Verdicts](verdicts.md)** — what `APPROVED`, `FLAGGED`, `BLOCKED`, and `PAUSED` mean.
- **[Kill switch](kill-switch.md)** — local halt and signed control-plane state (paid plans).
- **[Testing](testing.md)** — the public mock, in depth.
- **[API reference](api-reference.md)** — the complete surface.
