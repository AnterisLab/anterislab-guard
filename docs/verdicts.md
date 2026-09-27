
# Verdicts

Every guarded action ends with a verdict: the policy engine's answer to the
question *"may this action proceed?"*.

AnterisLab Guard recognizes four canonical verdicts. Only two of them
authorize the action; the other two deny it. **Anything else — an unknown
word, a missing field, a body that is not JSON, a truncated response — is
also a denial.** This is not an edge case. It is the default.

## The four canonical verdicts

| Verdict | Authorizes | Meaning |
|---|---|---|
| `APPROVED` | ✅ Yes | The policy allows the action. |
| `FLAGGED` | ✅ Yes | The policy allows the action, and the decision is worth noting (audit, review, higher scrutiny). |
| `PAUSED` | ❌ No | The action is suspended, pending human review. |
| `BLOCKED` | ❌ No | The policy denies the action. |

### `APPROVED`

The action may proceed. Nothing else to do.

```js
await safeCharge(4200);   // evaluated, then executed
```

### `FLAGGED`

The action may proceed, and the decision carries a `reason` that your code can
read for telemetry, audit, or additional scrutiny.

`FLAGGED` authorizes. Treat it as a soft signal, not as a warning that blocks
execution.

```js
guard.wrapFn(agent.charge, {
  agent: 'billing-bot',
  toAction: (amount) => ({ type: 'payment', amount }),
});

// If the verdict is FLAGGED, the action runs and `reason` is available on the
// decision object passed to `onDecision`.
```

### `PAUSED`

The action is suspended. The SDK calls the `onPaused` hook (if configured) and
then throws `GuardPausedError`.

The hook is a **notification**, not an authorization path. Whether it resolves,
rejects, or throws, **the action does not run.**

```js
new Guard({
  apiKey,
  onPaused: async (decision) => {
    await notifyReviewers(decision.reason, decision.decisionId);
  },
});

try {
  await safeCharge(4200);
} catch (error) {
  if (error instanceof GuardPausedError) {
    // A human has been notified. The action did not run.
  }
}
```

### `BLOCKED`

The policy denies the action. The SDK throws `GuardBlockedError`.

**Do not retry.** A denial is a decision. Retrying returns the same answer.

```js
try {
  await safeCharge(4200);
} catch (error) {
  if (error instanceof GuardBlockedError) {
    logger.warn('denied', {
      reason: error.reason,
      policy: error.policy,
    });
  }
}
```

## The allow-list rule

The SDK does not check for `BLOCKED`. It checks for `APPROVED` and `FLAGGED`,
and treats **everything else** as a denial.

This is a positive allow-list, and it is deliberate. The 0.1.1 version of this
SDK had the check inverted (`decision === 'BLOCKED'`), which meant a response
with `{ "verdict": "block" }` — the schema documented at the time — did not
match and the action executed. The fail-open behavior was not a transport bug:
it was the shape of the check.

The current rule is: **if a response does not look exactly like an authorizing
verdict, it does not authorize.**

## What is denied

Any of the following produces a denial (`GuardBlockedError`):

- A body that is not an object (string, number, array, `null`).
- A body that is not JSON (HTML from a captive portal, a proxy error page, a
  truncated response).
- A missing verdict field.
- An unrecognized word (`"YES_PLEASE"`, `"maybe"`, `"ok"`).
- A verdict field whose value is not a string.
- `UNAVAILABLE` — this word is reserved for the client and must never be sent
  by the server.
- A conflict between the `decision` and `verdict` fields (see below).
- A verdict whose `agent` field does not match the configured
  `expectedAgent`.

Each of these produces a `GuardBlockedError` with a `reason` and a stable
`code` from `parseVerdict`. The codes are useful for logging:

| Code | Meaning |
|---|---|
| `verdict_body_not_object` | The body was not a JSON object. |
| `verdict_missing` | No verdict field was found. |
| `verdict_unknown_word` | A verdict field had an unrecognized value. |
| `verdict_conflict` | Both fields were present and disagreed. |
| `verdict_server_emitted_local` | The server sent the client-reserved `UNAVAILABLE`. |
| `verdict_agent_mismatch` | The verdict was for a different agent. |

## Wire format

The SDK reads the verdict from the `decision` field. It also accepts a legacy
`verdict` field for backwards compatibility with clients that predate the
canonical name.

```json
{
  "decision": "APPROVED",
  "reason": "under daily limit",
  "policy": "daily-payment-limit",
  "agent": "billing-bot",
  "latency_ms": 3,
  "decision_id": "d-1234"
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `decision` | `string` | **Canonical.** One of the four verdicts, or a legacy alias. |
| `verdict` | `string` | **Legacy.** Mirror of `decision`. Accepted during the transition. |
| `reason` | `string` | Free text. Read by `onDecision` and by the error. |
| `policy` | `string` | Identifier of the policy that produced the verdict. |
| `agent` | `string` | The agent the verdict applies to. Checked against `expectedAgent`. |
| `latency_ms` | `number` | Backend-side evaluation latency, for telemetry. |
| `decision_id` | `string` | Unique id, useful for audit and for the server-side log. |

### The `decision` / `verdict` conflict

If both `decision` and `verdict` are present and canonicalize to **different**
values, the SDK refuses the response with `verdict_conflict`. It does **not**
pick the more permissive one, and it does **not** pick the more recent-looking
one. There is no reason for a well-formed response to disagree with itself, so
a disagreement is treated as a fault.

```json
{ "decision": "APPROVED", "verdict": "blocked" }
```

The SDK does not authorize this. It throws `GuardBlockedError` with
`code: "verdict_conflict"`.

## Legacy aliases

Older clients sent lowercase verbs instead of the canonical names. The SDK
still accepts them, because a coordinated release of every client is not
realistic. Each alias is a **full value**, never a substring: `"blockedness"`
does not match `blocked`.

| Alias | Canonical |
|---|---|
| `approve`, `approved`, `allow`, `allowed` | `APPROVED` |
| `flag`, `flagged` | `FLAGGED` |
| `pause`, `paused` | `PAUSED` |
| `block`, `blocked`, `deny`, `denied` | `BLOCKED` |

Aliases are case-insensitive. The canonical names are also accepted
case-insensitively (`"approved"` is treated the same as `"APPROVED"`).

**Do not rely on aliases in new integrations.** The backend emits the canonical
names, and the aliases exist only to keep old clients working during the
transition.

## The client-reserved verdict

`UNAVAILABLE` is reserved for the SDK itself. When the guard is unreachable and
`failOpen: true` is set, the SDK synthesizes a decision with `UNAVAILABLE` as
its internal status. **A server must never send `UNAVAILABLE`.** If it does,
the SDK rejects the response with
`code: "verdict_server_emitted_local"`.

## Where to go next

- [Error handling](error-handling.md) — how each verdict maps to an error
  class, and what to do with it.
- [Configuration](configuration.md) — `verifyVerdict`, `expectedAgent`, and
  the options that affect how verdicts are validated.
- [Kill switch](kill-switch.md) — a separate signal that can stop the action
  even after a positive verdict.
