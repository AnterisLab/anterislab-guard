
# Security model

This document describes what AnterisLab Guard protects against, what it does
not, and the assumptions under which its guarantees hold. It is intended for
security reviewers, auditors, and teams deploying agents in production.

For vulnerability reporting, see [SECURITY.md](../SECURITY.md).

## Scope

This document covers the **client SDK** (`@anterislab/guard`). The AnterisLab
control plane — the policy engine and the kill-switch service — is a separate
system and is out of scope here. Findings about the control plane are welcome
at the same address, under a separate process.

## What the SDK is for

An agent acts. Every action has side effects. The SDK exists to enforce a
single rule: **an action whose authorization cannot be established does not
execute.** That is the whole product.

This is different from a logging or observability library. The SDK does not
"observe" actions; it **gates** them. If the gate does not open, the action
does not happen.

## Trust boundaries

```
┌────────────────┐          ┌──────────────────┐          ┌────────────────┐
│  Agent code    │  ────▶   │  @anterislab/   │  ────▶   │  AnterisLab   │
│  (trusted)     │          │  guard (SDK)    │          │  control plane │
└────────────────┘          └──────────────────┘          └────────────────┘
                                     │
                                     │  HTTP / SSE over TLS
                                     ▼
                              ┌────────────────┐
                              │  Untrusted     │
                              │  network       │
                              └────────────────┘
```

- **Agent code** is trusted: it runs in your process.
- **The network between the SDK and the control plane** is untrusted. It may
  be observed, tampered with, or denied entirely.
- **The control plane** is trusted to be authoritative, but the SDK does not
  take its word over an untrusted channel. Every signal from the control plane
  must be cryptographically verifiable.

## Adversary model

The SDK is designed to defend against:

1. **A malicious or compromised network path** between the SDK and the control
   plane. This includes hostile proxies, poisoned DNS, a compromised CDN, and
   a rogue internal service.

2. **A misbehaving control plane** that returns malformed, unexpected, or
   contradictory responses — either accidentally (a bug) or maliciously (a
   compromise of the plane's response path but not its signing keys).

3. **The agent's own code being careless.** The default posture is protective:
   the SDK does not require you to remember to check for denials.

4. **Timing attacks on HMAC comparison.** The signature check runs in constant
   time.

The SDK does **not** defend against:

1. **A compromised host.** If an attacker can execute code in the same process
   as the agent, they can bypass the SDK entirely. No in-process library can
   defend against this.

2. **A compromised control plane signing key.** If the attacker holds the key
   that signs verdicts or kill-switch state, they can sign anything. The SDK
   cannot distinguish a legitimate signature from a forged one.

3. **An attacker who knows the API key.** The key authorizes requests to the
   control plane. If it leaks, the attacker can spend your quota and consume
   your evaluations. The SDK never writes the key to a URL, body, or error
   message, but it cannot protect a key that is already compromised outside
   the SDK.

4. **Denial of service.** The SDK does not attempt to keep the agent alive
   under attack. An unreachable control plane fails closed — the agent stops,
   by design.

5. **Side channels outside the SDK.** The SDK minimizes information leakage in
   its own error messages, but it cannot control what your application logs,
   reports, or persists.

## Guarantees

The SDK enforces the following properties. Each one is covered by the test
suite.

### 1. Positive allow-list

A verdict authorizes the action only if it is **exactly** one of the two
authorizing canonical values: `APPROVED` or `FLAGGED`. Anything else — an
unknown word, a missing field, a non-object body, HTML, truncated JSON, a
type mismatch, a conflict between the two verdict fields — is a denial.

This is a positive allow-list, not a deny-list. The difference is the whole
point: a deny-list can be bypassed by any input the author did not think of; a
positive allow-list cannot.

### 2. Verify-then-parse

When a signed verdict is required (`verifyVerdict`), the signature is verified
**before** the body is parsed into claims. Unauthenticated bytes never
influence a decision, not even indirectly through an error message.

The kill-switch state is verified with the same order: JWS structure → key
resolution → signature over the exact received bytes → structural claims →
audience / issuer / subject → time window → epoch → scope. Nothing below the
signature step trusts attacker-controlled bytes.

### 3. Constant-time HMAC comparison

When `verifyVerdict` is a string, the HMAC is compared in constant time. A
timing oracle on the comparison would otherwise leak the expected signature,
one byte at a time.

### 4. Algorithm allow-list

The kill-switch verifier accepts a configurable list of algorithms, defaulting
to `EdDSA` only. HS256 must be opted into explicitly.

The reason is the **key-confusion attack**: a verifier that accepts both
symmetric and asymmetric algorithms can be tricked into using a public key as
an HMAC secret. Keeping the two families apart at the configuration level
removes the attack surface entirely.

### 5. Fail-closed by default

When the guard is unreachable — timeout, network failure, `5xx` after the
retry budget, a `429` with an unacceptable `Retry-After`, a body that fails a
sanity check — the action is **denied**, not permitted.

`failOpen: true` exists as an explicit opt-in, and it is documented as the
non-default, less safe choice. It never produces a synthetic `APPROVED`, and
it never bypasses a `402`.

### 6. No retry on terminal decisions

`401`, `402`, `403`, and `409` are terminal. The SDK never retries them. A
retry would consume quota, and retrying a decision cannot change it.

`429` and `5xx` are retried, within the configured budget. `429` is honored
only if the declared `Retry-After` fits within `maxRetryAfterMs`; otherwise the
call fails closed.

### 7. Anti-TOCTOU on the kill switch

The kill switch is checked before the policy evaluation and **again** after a
positive verdict, against the same frozen state. A halt that arrives during
the evaluation window still stops the action.

### 8. Epoch anti-rollback

Signed kill-switch state carries a monotonic `epoch`. The client refuses any
token whose epoch is lower than the highest it has verified. This prevents a
replay attack where an old `RUNNING` token is presented after a `HALTED` one.

A rollback is treated as evidence of attack, not as a transient fault.

### 9. API key never leaves the request

The key is sent only in the `Authorization: Bearer` header. It is never placed
in a URL, a request body, or an error message.

As a defense in depth, the SDK rejects any response whose body contains the
key, on the assumption that a body containing the key is a body the server did
not intend to send.

### 10. Bounded inputs and outputs

- Response bodies larger than 256 KiB are rejected.
- Signed tokens larger than 8 KiB are rejected.
- Claim fields have per-field bounds (`reason`, `actor`, `evidence`, and
  others).
- Timeouts cover the whole transaction, including the body read, and do not
  depend on `fetch` honoring its own `signal`.

### 11. Host constraint

The API key travels only to hosts listed in `allowedHosts`. A misconfigured
`baseUrl` pointing to an unexpected host is rejected at construction.

`http://` is rejected everywhere except loopback, and only with
`allowInsecureHttp: true`.

### 12. Idempotency-Key reuse

The idempotency key is generated once per action and reused across retries, so
a retry cannot double-charge the plan quota. The key is not derived from the
action payload, so it does not leak action contents.

## Key material

| Material | Where it lives | What it protects |
|---|---|---|
| API key | Environment variable or secret manager, per agent | Requests to the control plane |
| Verdict HMAC secret | Shared with the backend, per tenant | Verdict authenticity |
| Kill-switch JWKS | Fetched from the control plane, cached | Kill-switch state authenticity |
| Kill-switch signing key | Control plane only | Kill-switch state authenticity |

The SDK holds the API key, the HMAC secret, and the public keys of the
kill-switch issuer. It does not hold the private keys of the control plane.

## Assumptions

The guarantees above hold under the following assumptions:

1. **The agent's process is not compromised.**
2. **The API key is kept secret.**
3. **The control plane's private signing keys are kept secret.**
4. **The clock on the agent's host is roughly correct.** Skew tolerance is
   configurable (`maxClockSkewSeconds`, default 60 seconds).
5. **The JWKS the SDK fetches comes from a trusted origin over TLS.**
6. **The operating system's TLS stack is not compromised.**

If any of these fail, the guarantees above do not apply.

## Failure modes

The SDK is explicit about what it does when things go wrong:

| Failure | Behavior |
|---|---|
| Guard unreachable | Fail-closed: `GuardUnavailableError`, action denied |
| Verdict unsigned or invalid signature | Fail-closed: `GuardBlockedError` |
| Kill-switch state cannot be verified | Fail-closed: `GuardStateInvalidError` or `GuardHaltedError` |
| Kill-switch state too stale | Fail-closed: `GuardStateInvalidError` |
| Epoch rollback | Fail-closed: the state is refused, an `error` event is emitted |
| Response body contains the API key | Fail-closed: `GuardUnavailableError` |
| Response body is not valid JSON | Treated as an unrecognized verdict: `GuardBlockedError` |
| Response body is too large | Fail-closed: `GuardUnavailableError` |
| Timeout on the body read | Fail-closed: `GuardUnavailableError` |

In every case, the action does not execute.

## What the SDK is not

- **Not a sandbox.** It gates actions you route through it. It does not
  confine the agent's code.
- **Not a content filter.** It evaluates actions against policies; it does not
  inspect arbitrary data.
- **Not a substitute for network security.** It assumes TLS, and it adds
  signature verification on top. It does not manage certificates or
  connections.
- **Not an authentication system.** It uses an API key the operator provides;
  it does not authenticate the user behind the agent.
- **Not a backup control plane.** If the control plane is unavailable, the
  agent stops (fail-closed). The SDK is designed this way; it is not a
  degraded mode.

## Review guidance

If you are auditing this SDK, the following files are where the guarantees
live:

- `src/verdict.ts` — the allow-list and verdict parsing.
- `src/transport.ts` — retry selection, timeout, body read, key-leak defense.
- `src/errors.ts` — the error hierarchy.
- `src/killswitch/verifier.ts` — JWS verification, algorithm allow-list, key resolution.
- `src/killswitch/client.ts` — state management, fail-closed posture, audit trail.
- `src/shared/killswitch-token.ts` — claim validation, epoch, scope.
- `src/shared/canonical-json.ts` — deterministic serialization used for hashing.

The SDK's own test suite (`test/`) is organized around these guarantees. Each
test is a statement of what the SDK must not do, and the suite is intended to
be read as a specification of the negative space: what cannot happen.

## Reporting

Vulnerability reports should be sent to **security@anterislab.com**, or
through GitHub's private vulnerability reporting. See
[SECURITY.md](../SECURITY.md) for the process, the scope, and the response
times.

We credit reporters in the published advisory, unless they prefer to remain
anonymous.
