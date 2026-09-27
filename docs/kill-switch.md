
# Kill switch

The kill switch is the emergency stop for a running agent. It lets you halt an
agent — locally, from a control-plane command, or by both — so that the next
guarded action is refused before it executes.

The kill switch is a **paid plan feature**. It is not included in the free
tier.

## What it gives you

1. **A local halt that works with no network at all.** `halt()` flips the
   client to `HALTED` synchronously, in-process, and every subsequent guarded
   action is refused. This is the ability to stop your agent even if the
   control plane is unreachable.

2. **Verified state, never a trusted transport.** `refresh()` fetches a signed
   state token and verifies its JWS signature locally against the issuer's
   public keys. A hostile proxy, a poisoned DNS answer, or a rogue internal
   service can deny the client a state (which fails closed) but cannot tell it
   "RUNNING" while the control plane says "HALTED".

3. **Fail-closed by default.** If the state cannot be established —
   unreachable, timeout, `5xx`, malformed or unsigned body, expired token,
   epoch rollback — the client treats the scope as halted and refuses the
   action.

## Enabling the kill switch

The kill switch is configured at construction:

```js
import { Guard } from '@anterislab/guard';

const guard = new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
  killSwitch: {
    tenant: 'acme',
    agent: 'billing-bot',
    baseUrl: 'https://www.anterislab.com',
    apiKey: process.env.ANTERISLAB_KILLSWITCH_KEY,
  },
});
```

When `killSwitch` is omitted, the gate is absent and no kill-switch check is
performed.

### Required fields

- `tenant` — the tenant this client belongs to.
- `agent` — the agent this client protects. The signed state's scope is
  checked against it.
- `baseUrl` — the control-plane origin.
- `apiKey` — a credential with the `killswitch:read` scope. Add
  `killswitch:report` if you want local halts to be reported to the control
  plane.

### Optional fields

- `audience` — expected `aud` claim in the signed token. Default:
  `anterislab-guard`.
- `issuers` — accepted `iss` values. Omitting this disables the issuer check
  (local development only).
- `maxStaleSeconds` — freshness bound for the verified state. Beyond it, the
  client fails closed. Default: `90`.
- `minRefreshIntervalSeconds` — minimum interval between network refreshes.
  Default: `15`.
- `failClosed` — fail closed when the state cannot be established. Default:
  `true`, and the only safe value.
- `allowFailOpen` — explicit acknowledgement required to set
  `failClosed: false`. See below.
- `jwks` — pre-loaded JWKS. Avoids a round trip, and is the only option for
  air-gapped deployments.
- `pinnedKeys` — pin keys directly by `kid`. Skips JWKS fetching entirely.
- `allowedAlgorithms` — allowed signature algorithms. Default: `['EdDSA']`.
  `HS256` must be opted into explicitly.
- `onEvent` — callback invoked on every state change and every refusal.
- `streamPath` — path for the SSE stream. Default:
  `/api/v1/killswitch/stream`.
- `now` — injected clock (Unix seconds) for deterministic tests.
- `digestHex` — injected digest function, for tests.

## Local halt

The panic button. It works with no network, in the current process, right
now.

```js
await guard.halt('incident in progress', 'INC-1234');
```

After this call, `guard.halted` is `true`, and every wrapped action throws
`GuardHaltedError` before executing.

### Reporting

A best-effort report is sent to the control plane so that the tenant-wide view
eventually agrees. The local halt stands regardless of whether the report
succeeds.

## Control-plane halt

The control plane can halt one agent or an entire tenant by issuing a signed
state token. The client fetches the token, verifies its signature locally, and
applies it.

State is fetched:

- On the first guarded action, if no state has been cached.
- When the cached state is older than `maxStaleSeconds`.
- On an explicit call to `guard.status()`.

Between refreshes, the client relies on the last verified state and on the
server-side enforcement as a second layer.

### Scope

A signed state token can be scoped:

- **`{tenant}`** — the halt applies to every agent in the tenant.
- **`{tenant, agent}`** — the halt applies to a single agent.

The client refuses a token whose scope does not cover the configured agent.

### Who can halt or resume

Any credential with the `killswitch:write` scope can halt or resume. There is
no separate "operator" role required.

### Propagation time

How fast a control-plane halt reaches the client depends on the client's
configuration:

| Configuration | Propagation |
|---|---|
| Default (`maxStaleSeconds: 90`) | Within 90 seconds on the next guarded action. |
| `maxStaleSeconds: 0` | On every guarded action, at the cost of a round trip per action. |
| `startStream()` enabled | In milliseconds, pushed over SSE. |

For agents that execute infrequently, `maxStaleSeconds: 0` gives the tightest
bound. For agents that execute often, the default avoids a round trip per
action.

## Push propagation with SSE

`startStream()` opens an SSE connection to the control plane. Halt and resume
events are pushed to the client as they occur, instead of waiting for the next
poll.

```js
const stop = await guard.startStream();

// ... later, when shutting down ...
stop();
```

The stream is best-effort: if it drops, the client falls back to the polling
behavior on the next guarded action. State received over the stream goes
through the **same verification path** as a poll — a transport is never a
substitute for a signature.

## Anti-TOCTOU: re-check after evaluation

The kill switch is checked **before** the policy evaluation, and **again**
after a positive verdict, against the frozen state.

This closes a small but real window: if a halt arrives between the policy
evaluation and the execution of the wrapped function, the re-check catches it
and the action is refused. The re-check does not perform a network call; it
uses the same frozen state that was used before evaluation.

## Epoch anti-rollback

Every signed state token carries an `epoch` — a monotonic counter, unique per
subject. The client tracks the highest epoch it has ever verified.

A token whose epoch is **lower than the highest verified epoch** is rejected
with `KillSwitchRollbackError`. This defends against a replay attack where an
attacker presents an old `RUNNING` token after the control plane has issued a
`HALTED` one.

A rollback is treated as evidence of an attack, not as a transient fault. It
is logged and, in the local audit trail, recorded as an `error` event.

## Resuming

A local halt is not silently cleared by a refresh. It is cleared only by:

- A **verified control-plane state** that is newer than the local halt.
- An explicit **break-glass** resume, which requires a reason and is recorded
  as such in the audit trail.

```js
// Normal path: requires the control plane to say RUNNING.
await guard.resume({ reason: 'incident resolved', evidence: 'INC-1234' });

// Break-glass: bypasses the requirement, demands a reason.
await guard.resume({ reason: 'emergency override', breakGlass: true });
```

After a break-glass resume, the next `enforce()` re-verifies against the
control plane. The getter `guard.halted` remains `true` until that
re-verification happens. This is deliberate: "not halted" from break-glass
means "allow the next enforce to re-check", not "authorize now".

## Fail-closed posture

The kill switch is fail-closed by default, and by design. If the state cannot
be established — for any of the reasons listed above — the client treats the
scope as halted and refuses the action.

### `failClosed: false` and `allowFailOpen`

Setting `failClosed: false` disables the fail-closed behavior. To prevent a
silent change in the security posture, this requires a second flag:

```js
killSwitch: {
  tenant: 'acme',
  agent: 'billing-bot',
  baseUrl: '...',
  apiKey: '...',
  failClosed: false,
  allowFailOpen: true,   // required, and deliberate
}
```

Both flags must be set. Every fail-open event is recorded in the local audit
trail.

**Do not disable fail-closed on a production agent.** The whole point of the
kill switch is to stop the agent even when you cannot talk to it.

## The local audit trail

Every activation — control-plane halt, local halt, a refusal, a resume —
is appended to a local, hash-chained audit trail. The operator can export it
alongside the server-side chain.

```js
const entries = guard.killSwitch?.auditTrail();
```

Each entry contains: sequence number, timestamp, action, reason, epoch,
verification flag, previous hash, and its own hash. The chain is bounded in
memory (1000 entries, then the oldest 500 are dropped) so that a long-running
agent does not grow indefinitely; the durable record is the server-side chain.

### Verifying the chain

```js
const result = await guard.killSwitch?.verifyAuditTrail();
// { valid: true, length: N }  or  { valid: false, length: N, broken_at: seq }
```

The verification recomputes the hash chain and reports the first broken link,
if any.

### Actions recorded

| Action | When |
|---|---|
| `local_halt` | `halt()` was called. |
| `local_resume` | A local halt was cleared (normal or break-glass). |
| `refused` | An action was refused. |
| `state_applied` | A verified control-plane state was applied. |
| `stream_open` | The SSE stream was opened. |
| `fail_open_warning` | A fail-open decision was made. |

## Error classes

| Class | When |
|---|---|
| `KillSwitchHaltedError` | The switch is engaged (local or control-plane). |
| `KillSwitchUnavailableError` | The state could not be established. |
| `KillSwitchStaleError` | The verified state is older than `maxStaleSeconds`. |
| `KillSwitchRollbackError` | A token presented an epoch lower than the highest verified. |
| `KillSwitchStateInvalidError` | A token's signature, claims, or scope could not be trusted. |
| `KillSwitchLocalHaltError` | A `resumeLocal()` was refused (no newer verified state, or missing reason for break-glass). |
| `KillSwitchConfigError` | Invalid kill-switch configuration. |

Every subclass extends `KillSwitchError`, which sets `failClosed = true` as a
property. This makes the posture a deliberate field on the error, not an
emergent behavior.

## See also

- [Configuration](configuration.md) — the `killSwitch` option block.
- [Error handling](error-handling.md) — how to react to each error class.
- [API reference](api-reference.md) — `KillSwitchManager`, `KillSwitchStatus`,
  and the exported types.
