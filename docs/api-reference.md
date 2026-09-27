
# API reference

The complete public surface of `@anterislab/guard`. All symbols below are
exported from the package root unless marked otherwise.

- [Guard class](#guard-class)
- [Error classes](#error-classes)
- [Utility functions](#utility-functions)
- [Constants](#constants)
- [Types](#types)
- [Kill switch](#kill-switch)
- [Mock module](#mock-module)

## Guard class

### `new Guard(options: GuardOptions)`

Creates a guard. The constructor validates the configuration and throws
`GuardConfigError` for anything that would weaken the guarantees.

See [configuration.md](configuration.md) for every option.

### `guard.wrap<T>(target: T, options: WrapOptions): T`

Wraps an object so that **every method** goes through the gate before
executing. Methods listed in `passthrough` are exempt.

Returns a `Proxy` over `target`. The original object is not modified.

```js
const safe = guard.wrap(agent, { agent: 'billing-bot', passthrough: ['describe'] });
await safe.charge(10);       // evaluated
safe.describe();             // passthrough
```

**Throws:** any `GuardError` from the underlying `decide()` call.

### `guard.wrapFn<A, R>(fn, options: WrapFnOptions<A>): (...args: A) => Promise<R>`

Wraps a single function. The action is derived from the arguments by the
`toAction` mapper.

```js
const charge = guard.wrapFn(agent.charge, {
  agent: 'billing-bot',
  toAction: (amount) => ({ type: 'payment', amount, currency: 'EUR' }),
});
await charge(4200);
```

**Throws:** any `GuardError` from the underlying `decide()` call.

### `guard.decide(action, agent): Promise<ParsedDecision>`

Evaluates an action and decides. This is the **only place** where a decision is
made. `wrap` and `wrapFn` both call it.

Returns the decision when the action may proceed; throws otherwise.

Use this directly if you need fine-grained control over the action descriptor
and don't want to wrap a function.

```js
const decision = await guard.decide(
  { type: 'payment', amount: 100, currency: 'EUR' },
  'billing-bot',
);
console.log(decision.decision);   // 'APPROVED' | 'FLAGGED'
```

### `guard.halt(reason, evidence?): Promise<KillSwitchStatus>`

Engages the kill switch **locally, right now**, with no network round-trip.
Requires `killSwitch` to be configured; otherwise throws `GuardConfigError`.

See [kill-switch.md](kill-switch.md).

### `guard.resume(options): Promise<KillSwitchStatus>`

Clears a local halt. Requires a verified control-plane state newer than the
halt, or `breakGlass: true` with an explicit reason.

```js
await guard.resume({ reason: 'incident resolved', evidence: 'INC-1234' });
```

### `guard.status(): Promise<KillSwitchStatus>`

Returns the current kill-switch status (verified). Refreshes if the cached
state is stale.

### `guard.startStream(): Promise<() => void>`

Opens the SSE stream for push propagation of halt/resume events. Returns a
`stop` function.

```js
const stop = await guard.startStream();
// ...
stop();   // closes the stream
```

## Error classes

Every error thrown by the SDK extends `GuardError`. A single `catch` block can
distinguish between all the cases.

| Class | `code` | When it is thrown |
|---|---|---|
| `GuardBlockedError` | `GUARD_BLOCKED` | The policy denied, or the verdict was unrecognized |
| `GuardPausedError` | `GUARD_PAUSED` | Verdict is `PAUSED`; human review required |
| `GuardHaltedError` | `GUARD_HALTED` | Kill switch is active |
| `GuardQuotaError` | `GUARD_QUOTA_EXCEEDED` | `402`; plan quota exhausted |
| `GuardAuthError` | `GUARD_UNAUTHORIZED` (401) / `GUARD_FORBIDDEN` (403) | Invalid key or agent out of scope |
| `GuardPolicyError` | `GUARD_STALE_POLICY` | `409`; stale policy snapshot |
| `GuardUnavailableError` | `GUARD_UNAVAILABLE` | Guard unreachable (timeout, network, `5xx`) |
| `GuardConfigError` | `GUARD_CONFIG` | Invalid configuration |
| `GuardStateInvalidError` | `GUARD_STATE_INVALID` | Kill-switch state too stale |

See [error-handling.md](error-handling.md) for reactions and examples.

### `GuardError`

Base class. Properties:

- `code: string` — stable, meant for logs and metrics. Never use it for
  control flow; use `instanceof` instead.
- `blocked: boolean` — `true` when the action was not executed. Always `true`
  except for the documented fail-open case.

### `GuardBlockedError`

- `reason: string` — the reason from the verdict or from the SDK.
- `policy: string | null` — the policy that denied.
- `decisionId: string | null` — the backend decision id, when available.

### `GuardQuotaError`

- `plan: string | null`
- `limit: number | null`
- `used: number | null`

### `GuardUnavailableError`

- `failOpenApplied: boolean` — `true` when the caller explicitly opted into
  `failOpen` and the action proceeded anyway.

### `GuardHaltedError`

- `origin: 'control-plane' | 'local' | 'fail-closed'`
- `epoch: number | null`

## Utility functions

### `parseVerdict(body, expectedAgent?): VerdictOutcome`

Parses an `/evaluate` response body into a canonical decision. Implements the
allow-list: only `APPROVED` and `FLAGGED` authorize; everything else is a
denial.

Used internally by `Guard.decide()`. Exported for advanced integrations.

```js
const outcome = parseVerdict({ decision: 'BLOCKED', reason: 'limit' });
if (outcome.ok) {
  console.log(outcome.decision.decision);
}
```

### `canonicalizeVerdict(value): CanonicalVerdict | null`

Normalizes a raw value to a canonical verdict. Returns `null` for unrecognized
values. Accepts legacy aliases (`allow`, `approved`, `block`, `deny`, ...) and
the canonical names.

```js
canonicalizeVerdict('allow');        // 'APPROVED'
canonicalizeVerdict('YES_PLEASE');   // null
```

### `isAuthorizing(verdict): boolean`

Returns `true` only for `APPROVED` and `FLAGGED`.

### `actionDigest(action): string`

Computes a SHA-256 digest of the action, with deterministic key ordering.
Used internally to fingerprint the arguments of a wrapped function.

## Constants

### `SDK_VERSION`

The current version of the SDK. Included in the `x-anterislab-sdk` header on
every request.

```js
import { SDK_VERSION } from '@anterislab/guard';
console.log(SDK_VERSION);   // e.g. '0.2.1'
```

## Types

All types are exported as TypeScript types. They are not runtime values.

### `GuardOptions`

Constructor options for `Guard`. See [configuration.md](configuration.md).

### `WrapOptions`

```ts
interface WrapOptions {
  agent: string;
  passthrough?: readonly string[];
}
```

### `WrapFnOptions<A>`

```ts
interface WrapFnOptions<A extends unknown[]> {
  agent: string;
  toAction: (...args: A) => Record<string, unknown>;
}
```

### `GuardAction`

The shape of the action descriptor sent to `/api/v1/evaluate`. Only `type` is
required.

```ts
interface GuardAction {
  type: string;
  target?: string;
  domain?: string;
  amount?: number;
  currency?: string;
  recipients?: number;
  query?: string;
  direction?: 'inbound' | 'outbound';
  external?: boolean;
  metadata?: Record<string, unknown>;
}
```

### `CanonicalVerdict`

```ts
type CanonicalVerdict = 'APPROVED' | 'FLAGGED' | 'PAUSED' | 'BLOCKED';
```

### `ParsedDecision`

The result of a successful `parseVerdict` or `decide`.

```ts
interface ParsedDecision {
  decision: CanonicalVerdict;
  reason: string;
  policy: string | null;
  decisionId: string | null;
  latencyMs: number | null;
  agent: string | null;
}
```

### `VerdictOutcome`

```ts
type VerdictOutcome =
  | { ok: true; decision: ParsedDecision }
  | { ok: false; code: string; detail: string };
```

## Kill switch

The kill switch is documented in depth in [kill-switch.md](kill-switch.md).
This section is a quick reference for the exports.

### `KillSwitchManager`

The class behind `guard.halt()`, `guard.resume()`, `guard.status()`, and
`guard.startStream()`. Can be instantiated directly for use outside `Guard`.

See [kill-switch.md](kill-switch.md).

### Kill-switch error classes

| Class | `code` |
|---|---|
| `KillSwitchError` (base) | — |
| `KillSwitchHaltedError` | `KILL_SWITCH_HALTED` |
| `KillSwitchUnavailableError` | `KILL_SWITCH_STATE_UNAVAILABLE` |
| `KillSwitchStaleError` | `KILL_SWITCH_STATE_STALE` |
| `KillSwitchRollbackError` | `KILL_SWITCH_STATE_ROLLBACK` |
| `KillSwitchStateInvalidError` | `KILL_SWITCH_STATE_INVALID` |
| `KillSwitchLocalHaltError` | `KILL_SWITCH_LOCAL_HALT` |

Every subclass extends `KillSwitchError`, which sets `failClosed = true`.

### `KillSwitchStatus`

```ts
interface KillSwitchStatus {
  halted: boolean;
  reason: string;
  epoch: number;
  origin: 'control-plane' | 'local';
  verified: boolean;
  tenant: string;
  agent: string;
  at: number;
  fetchedAt: number | null;
  token?: string;
}
```

### `KillSwitchClientEvent`

```ts
interface KillSwitchClientEvent {
  type: 'state' | 'halted' | 'resumed' | 'refused' | 'error'
      | 'local_halt' | 'local_resume';
  at: number;
  epoch?: number;
  reason: string;
  origin?: 'control-plane' | 'local';
}
```

## Mock module

Imported via the `@anterislab/guard/mock` subpath. Never included in the main
bundle.

See [testing.md](testing.md) for usage.

### `createMockFetch(responder): MockFetch`

Creates a mock `fetch` implementation. Never performs a network call.

```js
import { createMockFetch, approvedVerdict } from '@anterislab/guard/mock';

const mock = createMockFetch({ status: 200, body: approvedVerdict() });
const guard = new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch });
```

### `MockFetch`

```ts
interface MockFetch {
  fetch: typeof fetch;
  calls: MockRequest[];
  readonly evaluateCalls: number;
  reset(): void;
}
```

### `MockRoute`

```ts
interface MockRoute {
  status: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  delayMs?: number;
}
```

### `MockRequest`

```ts
interface MockRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}
```

### `MockResponder`

```ts
type MockResponder =
  | MockRoute
  | readonly MockRoute[]
  | ((request: MockRequest) => MockRoute);
```

### Verdict builders

- `approvedVerdict(agent?, extra?)`
- `flaggedVerdict(agent?, extra?)`
- `blockedVerdict(reason?, extra?)`
- `pausedVerdict(reason?, extra?)`

Each returns a canonical verdict body as a plain object.

### `signBody(secret, rawBody): string`

Computes an HMAC-SHA256 signature over `rawBody`, formatted as
`sha256=<hex>`, matching what `verifyVerdict` expects.

```js
const body = JSON.stringify(approvedVerdict());
const signature = signBody(SECRET, body);
const mock = createMockFetch({
  status: 200,
  raw: body,
  headers: { 'x-anterislab-signature': signature },
});
```
