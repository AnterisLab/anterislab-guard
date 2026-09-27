
# Configuration

Every option accepted by `new Guard(...)`. Options marked **required** must be
provided; all others have safe defaults.

```js
import { Guard } from '@anterislab/guard';

const guard = new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
});
```

## Required

### `apiKey`

**Type:** `string` — **Required**

The API key for the agent. Obtained from the AnterisLab dashboard.

The key never appears in URLs, request bodies, or error messages. The SDK
rejects any response whose body contains the key, as a defense in depth.

Do not hardcode it. Read it from an environment variable or a secret manager.

```js
new Guard({ apiKey: process.env.ANTERISLAB_API_KEY });
```

## Connection

### `baseUrl`

**Type:** `string` — **Default:** `https://www.anterislab.com`

The origin of the AnterisLab control plane. Must be listed in `allowedHosts`.

```js
new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
  baseUrl: 'https://www.anterislab.com',
});
```

### `allowedHosts`

**Type:** `readonly string[]` — **Default:** `['www.anterislab.com', 'anterislab.com']`

The hosts the API key is allowed to travel to. If `baseUrl` resolves to a host
not in this list, the constructor throws `GuardConfigError`. This is a
deliberate constraint: the key must never be sent to an unexpected host, even
in case of a configuration mistake.

```js
new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
  baseUrl: 'https://staging.anterislab.com',
  allowedHosts: ['staging.anterislab.com'],
});
```

### `allowInsecureHttp`

**Type:** `boolean` — **Default:** `false`

Allows `http://` (unencrypted) **only** on loopback addresses (`localhost`,
`127.0.0.1`, `::1`). Intended for local development. On any other host, `http://`
is rejected at construction.

```js
new Guard({
  apiKey: 'test-key',
  baseUrl: 'http://127.0.0.1:8787',
  allowInsecureHttp: true,
  allowedHosts: ['127.0.0.1'],
});
```

**Warning:** enabling this does not permit cleartext traffic to a non-loopback
host. It only relaxes the check for local development.

## Transport

### `timeoutMs`

**Type:** `number` — **Default:** `5000`

Timeout for the entire transaction, **including the response body read**. This
matters because `fetch` resolves as soon as the headers arrive; without an
explicit bound on the body read, a stalled endpoint could block the agent
forever.

```js
new Guard({ apiKey, timeoutMs: 10_000 });
```

### `retries`

**Type:** `number` — **Default:** `1`

Maximum retries on transport failures and `5xx` responses. **Never** applied
to `401`, `402`, `403`, or `409`: those are terminal decisions, not transient
errors.

Retries use exponential backoff with jitter.

```js
new Guard({ apiKey, retries: 3 });
```

### `maxRetryAfterMs`

**Type:** `number` — **Default:** `30000`

Maximum delay the SDK will honor from a `Retry-After` header on a `429`
response. If the server requests a longer wait, the SDK rejects the call with
`GuardUnavailableError` rather than blocking the agent for too long.

```js
new Guard({ apiKey, maxRetryAfterMs: 60_000 });
```

### `idempotency`

**Type:** `boolean` — **Default:** `true`

Sends an `Idempotency-Key` header on every evaluation. The key is generated
once per action and reused across retries, so a retry does not consume plan
quota twice.

```js
new Guard({ apiKey, idempotency: false });   // disable (not recommended)
```

### `fetchImpl`

**Type:** `typeof fetch` — **Default:** `globalThis.fetch`

Override the `fetch` implementation. Use this for testing with the public mock,
or to plug a custom HTTP client.

```js
import { createMockFetch, approvedVerdict } from '@anterislab/guard/mock';

const mock = createMockFetch({ status: 200, body: approvedVerdict() });
new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch });
```

## Behavior

### `failOpen`

**Type:** `boolean` — **Default:** `false`

When the guard is unreachable (timeout, network failure, `5xx` after retries),
the SDK **fails closed** by default: the action is denied with
`GuardUnavailableError`.

Setting `failOpen: true` allows the action to proceed and records a synthetic
`UNAVAILABLE` decision. **It never raises a real `APPROVED` and never bypasses
a `402` (quota exhausted).**

```js
new Guard({ apiKey, failOpen: true });
```

**Use with caution.** The default (`false`) is what keeps your agent safe when
the control plane is unavailable. Only enable `failOpen` if you have an
independent reason to trust the action.

### `expectedAgent`

**Type:** `string` — **Default:** none

Pins the client to a single agent identity. Any action requested for a
different agent is rejected locally, before the network call, with
`GuardBlockedError`.

```js
new Guard({ apiKey, expectedAgent: 'billing-bot' });
```

Useful when you want a hard guarantee that a specific process can only act on
behalf of one agent.

## Verdict verification

### `verifyVerdict`

**Type:** `string | ((rawBody: string, signature: string | null) => boolean)` — **Default:** none

When set, every verdict the SDK receives must carry a valid signature. An
unsigned or invalidly signed **positive** verdict (i.e. `APPROVED` or
`FLAGGED`) is rejected with `GuardBlockedError`.

- **`string`:** an HMAC-SHA256 secret shared with the backend. The SDK compares
  the signature in constant time.
- **`function`:** a custom verifier `(rawBody, signature) => boolean`. Use this
  for asymmetric signatures or a non-standard header format.

```js
// HMAC mode
new Guard({
  apiKey,
  verifyVerdict: process.env.ANTERISLAB_VERDICT_SECRET,
});

// Custom verifier
new Guard({
  apiKey,
  verifyVerdict: (body, signature) => myVerifier(body, signature),
});
```

**Warning:** enabling this requires the backend to be configured to sign
verdicts. If the backend is not signing, every positive verdict will be
rejected and your agent will be unable to act.

### `signatureHeader`

**Type:** `string` — **Default:** `'x-anterislab-signature'`

The HTTP header the signature is read from. Only relevant when `verifyVerdict`
is set. Accepts both `sha256=<hex>` and bare `<hex>` formats.

```js
new Guard({ apiKey, verifyVerdict: SECRET, signatureHeader: 'x-my-signature' });
```

## Observability

### `onDecision`

**Type:** `(decision: ParsedDecision, action: Record<string, unknown>) => void` — **Default:** none

Called for **every** verdict the SDK uses, including synthetic fail-open
decisions. Useful for telemetry and audit logs.

**The hook cannot change the outcome.** If it throws, the exception is
swallowed. This is deliberate: telemetry must never influence a security
decision.

```js
new Guard({
  apiKey,
  onDecision: (decision, action) => {
    logger.info('verdict', { decision: decision.decision, action });
  },
});
```

### `onPaused`

**Type:** `(decision: ParsedDecision, action: Record<string, unknown>) => void | Promise<void>` — **Default:** none

Called when the verdict is `PAUSED`. The hook is a **notification only**: if it
resolves, rejects, or throws, the action does not run. `PAUSED` always blocks.

```js
new Guard({
  apiKey,
  onPaused: async (decision) => {
    await notifyReviewers(decision.reason, decision.decisionId);
  },
});
```

## Kill switch

### `killSwitch`

**Type:** `KillSwitchManagerOptions` — **Default:** none

Enables the kill-switch gate. When omitted, the gate is absent and the SDK
skips the kill-switch check entirely.

See [kill-switch.md](kill-switch.md) for the full option reference.

```js
new Guard({
  apiKey,
  killSwitch: {
    tenant: 'acme',
    agent: 'billing-bot',
    baseUrl: 'https://www.anterislab.com',
    apiKey: process.env.ANTERISLAB_KILLSWITCH_KEY,
  },
});
```

## Interaction between options

- **`failOpen: true` does not relax the kill switch.** A halt arriving during
  a fail-open decision still stops the action.
- **`failOpen: true` does not bypass `402`.** Quota exhaustion is a decision,
  not an availability problem.
- **`verifyVerdict` applies to positive verdicts only.** A `BLOCKED` response
  is accepted without signature verification (it denies the action, which is
  the safe outcome either way).
- **`expectedAgent` and `killSwitch.agent` are independent.** The former pins
  the client; the latter scopes the kill-switch state. Set them both if you
  want the strongest guarantees.
