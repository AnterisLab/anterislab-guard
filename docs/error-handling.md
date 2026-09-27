
# Error handling

Every error thrown by `@anterislab/guard` extends `GuardError`. A single
`catch` block can distinguish between a policy denial, a quota exhaustion, an
authentication failure, and an unreachable guard — and react accordingly.

```js
import {
  GuardError,
  GuardBlockedError,
  GuardPausedError,
  GuardHaltedError,
  GuardQuotaError,
  GuardAuthError,
  GuardPolicyError,
  GuardUnavailableError,
  GuardConfigError,
  GuardStateInvalidError,
} from '@anterislab/guard';

try {
  await safeCharge(4200);
} catch (error) {
  if (error instanceof GuardBlockedError) {
    // The policy denied. Do not retry: it is a decision.
  } else if (error instanceof GuardQuotaError) {
    // Plan quota exhausted. Upgrade your plan.
  } else if (error instanceof GuardAuthError) {
    // Invalid key, or agent out of scope.
  } else if (error instanceof GuardUnavailableError) {
    // The guard is unreachable. Fail-closed by default.
  } else if (error instanceof GuardError) {
    // Any other guard error. `error.code` is stable for logs and metrics.
  }
}
```

## The two families

Before looking at individual classes, it helps to think of two families:

- **Decisions** — the policy engine evaluated the action and returned an
  answer. The answer is "no". Do **not** retry: retrying will return the same
  answer, and may consume quota.
- **Availability problems** — the SDK could not reach a decision, or could
  not trust one. The default posture is **fail-closed**: the action is denied
  to be safe.

Both are failures from your agent's point of view, but the right reaction
differs.

| Family | Classes | Retry? | Alert? |
|---|---|---|---|
| Decision | `GuardBlockedError`, `GuardPausedError`, `GuardHaltedError`, `GuardQuotaError`, `GuardAuthError`, `GuardPolicyError` | No | Depends |
| Availability | `GuardUnavailableError`, `GuardStateInvalidError` | Maybe | Yes |
| Configuration | `GuardConfigError` | No (fix the config) | Yes (at startup) |

## Base class: `GuardError`

- `code: string` — a stable identifier for the error class, meant for logs and
  metrics. **Do not use it for control flow.** Use `instanceof` instead.
- `blocked: boolean` — `true` when the action was not executed. It is `true`
  for every subclass except when `failOpen` was explicitly enabled.

## Decisions

### `GuardBlockedError`

**When:** the policy engine returned `BLOCKED`, or the response body could not
be parsed into a recognized positive verdict.

**What to do:** do not retry. A denial is a decision. Log the reason, and if
the action is critical, surface the denial to the operator.

```js
try {
  await safeCharge(4200);
} catch (error) {
  if (error instanceof GuardBlockedError) {
    logger.warn('action denied', {
      reason: error.reason,
      policy: error.policy,
      decisionId: error.decisionId,
    });
    // Do not retry. Escalate if the denial was unexpected.
  }
}
```

**Properties:** `reason`, `policy`, `decisionId`.

### `GuardPausedError`

**When:** the verdict is `PAUSED`. The action is suspended pending human
review.

**What to do:** do not retry. The `onPaused` hook (if configured) has already
been called. Wait for the review to complete, then try again if appropriate.

```js
if (error instanceof GuardPausedError) {
  // The onPaused hook has been called. The action did not run.
  // Surface to the operator, and do not retry automatically.
}
```

**Properties:** `reason`, `decisionId`.

### `GuardHaltedError`

**When:** the kill switch is engaged, either locally (`halt()`) or via the
control plane.

**What to do:** do not retry. Wait for a resume. If the halt is local, call
`guard.resume()` after the incident.

```js
if (error instanceof GuardHaltedError) {
  logger.warn('kill switch active', {
    origin: error.origin,
    epoch: error.epoch,
    reason: error.message,
  });
  // Wait for the halt to be cleared. Do not retry in a loop.
}
```

**Properties:** `origin` (`'control-plane' | 'local' | 'fail-closed'`),
`epoch`.

### `GuardQuotaError`

**When:** the control plane returned `402`. The plan quota is exhausted.

**What to do:** do not retry. **Terminal.** Upgrade the plan, or wait for the
next billing cycle. **A `402` is never bypassed by `failOpen`.**

```js
if (error instanceof GuardQuotaError) {
  logger.error('quota exhausted', {
    plan: error.plan,
    limit: error.limit,
    used: error.used,
  });
  // Upgrade the plan: https://anterislab.com/pricing
}
```

**Properties:** `plan`, `limit`, `used`.

### `GuardAuthError`

**When:** the control plane returned `401` or `403`. The API key is missing,
invalid, or revoked; or the agent is out of scope.

**What to do:** do not retry. Check the API key, and check that the agent's
identity matches the scope granted by the plan.

```js
if (error instanceof GuardAuthError) {
  logger.error('authentication failed', {
    status: error.status,   // 401 or 403
    code: error.code,       // GUARD_UNAUTHORIZED or GUARD_FORBIDDEN
  });
  // Verify the API key, and that the agent is in scope.
}
```

**Properties:** `status` (`401` or `403`).

### `GuardPolicyError`

**When:** the control plane returned `409`. The client's policy snapshot is
stale.

**What to do:** do not retry blindly. The SDK does not expose a policy
realignment API at this time; a fresh client will pick up the current policy
snapshot on the next evaluation. If the error persists, contact support.

**Properties:** `expected`, `received`.

## Availability problems

### `GuardUnavailableError`

**When:** the guard is unreachable — timeout, network failure, `5xx` after the
retry budget, `429` with an unacceptable `Retry-After`, or a response that
failed a sanity check (body too large, key leak detected).

**What to do:** the default posture is **fail-closed**: the action is denied.
Depending on your tolerance, you may retry the action after a delay, or
escalate.

If `failOpen: true` was set, the SDK returns a synthetic `UNAVAILABLE`
decision and the action proceeds. **This never raises a real `APPROVED` and
never bypasses a `402`.**

```js
if (error instanceof GuardUnavailableError) {
  logger.error('guard unreachable', {
    failOpenApplied: error.failOpenApplied,
  });
  // Retry with backoff, or escalate. The action did not run.
}
```

**Properties:** `failOpenApplied`.

### `GuardStateInvalidError`

**When:** the kill-switch state is too stale to trust. This is a specific
fail-closed case: the state exists, but it is not fresh enough to authorize
proceeding.

**What to do:** investigate connectivity between the client and the control
plane. This is usually a symptom of a network partition or a misconfigured
`maxStaleSeconds`.

```js
if (error instanceof GuardStateInvalidError) {
  logger.error('kill-switch state is stale', { reason: error.message });
}
```

## Configuration

### `GuardConfigError`

**When:** the `Guard` constructor received an invalid configuration (missing
API key, `http://` on a non-loopback host, a signing secret that is too short,
and so on).

**What to do:** fix the configuration. This error is always thrown at
construction time, before any evaluation. If you see it in production, the
deployment is broken.

```js
try {
  const guard = new Guard({ apiKey: process.env.ANTERISLAB_API_KEY });
} catch (error) {
  if (error instanceof GuardConfigError) {
    logger.fatal('invalid configuration', { reason: error.message });
    process.exit(1);
  }
}
```

## What not to do

- **Do not use `error.code` for control flow.** Codes are stable, but
  `instanceof` is the intended interface and is what the type system checks.
- **Do not retry a decision.** `BLOCKED`, `PAUSED`, `HALTED`, `402`, `401`,
  `403`, and `409` are terminal.
- **Do not swallow `GuardUnavailableError`.** The action did not run. If your
  agent continues as if it did, you have a correctness bug.
- **Do not enable `failOpen` to make errors go away.** It changes the security
  posture. If you need it, use it deliberately and document why.

## See also

- [Configuration](configuration.md) — options that affect error behavior
  (`retries`, `failOpen`, `timeoutMs`, `verifyVerdict`).
- [Verdicts](verdicts.md) — the meanings behind `APPROVED`, `FLAGGED`,
  `BLOCKED`, `PAUSED`.
- [Kill switch](kill-switch.md) — the module behind `GuardHaltedError` and
  `GuardStateInvalidError`.
