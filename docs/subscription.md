
# Subscription

AnterisLab Guard is the open-source client SDK for the AnterisLab policy
engine. The SDK source is free to read, audit, and self-host as a client. The
**policy engine and the kill switch run in the AnterisLab cloud**, and talking
to them requires an active subscription.

This document explains what the free tier includes, what happens when it
expires, and how to upgrade.

## Free tier (trial)

The trial gives you enough to evaluate the SDK against a real control plane.

| | |
|---|---|
| **Duration** | 14 days from activation. |
| **Evaluations** | 500 per month. |
| **Agents** | 1. |
| **API keys** | 1. |
| **Rate limit** | 60 requests per minute. |
| **Audit retention** | 7 days. |
| **Per-action limit** | 100 EUR. |
| **Kill switch** | Not included. |

The per-action limit is an example of a policy the control plane enforces on
the trial: an action above 100 EUR is denied, regardless of what the rest of
your policies say. It exists so that a trial cannot be used for high-value
operations.

The kill switch is a paid feature. In the trial, a `Guard` configured with
`killSwitch` will fail at the first evaluation with a configuration error.

## Activating the trial

You can activate the trial from two places:

- **The pricing page** — <https://anterislab.com/pricing>.
- **The dashboard** — `Profile` section, where your current plan is shown.

## What happens when the trial expires

At the end of the 14 days, the control plane returns **`402`** on the next
evaluation. The SDK surfaces this as `GuardQuotaError`:

```js
import { Guard, GuardQuotaError } from '@anterislab/guard';

const guard = new Guard({ apiKey: process.env.ANTERISLAB_API_KEY });

try {
  await guard.wrapFn(myAction, { agent: 'billing-bot', toAction: () => ({ ... }) })();
} catch (error) {
  if (error instanceof GuardQuotaError) {
    // The plan quota is exhausted. Upgrade to continue.
    console.error(`quota exhausted: plan=${error.plan} limit=${error.limit} used=${error.used}`);
  }
}
```

**`402` is terminal.** The SDK does not retry it, and `failOpen: true` does
**not** bypass it. Quota exhaustion is a decision, not an availability
problem.

## What happens when the monthly quota is exhausted

The trial includes 500 evaluations per month. If your agent uses them all
before the month ends, the control plane returns `402` on the next evaluation
in the same way as an expired trial.

## Upgrading

Upgrade from the same two places:

- **Pricing page** — <https://anterislab.com/pricing>.
- **Dashboard** — `Profile` section, where your current plan is shown and can
  be changed.

After upgrading, the next evaluation succeeds without any change to your code.
The API key remains the same.

## What changes after upgrading

Paid plans relax the trial limits. The specific limits depend on the plan. In
general, upgrading unlocks:

- More evaluations per month.
- More agents, and more API keys.
- Higher rate limits.
- Longer audit retention.
- Higher (or no) per-action limit.
- **The kill switch.**
- Priority support.

See <https://anterislab.com/pricing> for the exact numbers of each plan.

## The kill switch and subscription

The kill switch is not available in the trial. Configuring it during the trial
will fail at the first evaluation with a configuration error.

If your code optionally enables the kill switch, gate it behind a check so the
same code runs in trial and in production:

```js
const killSwitchEnabled = process.env.ANTERISLAB_PLAN !== 'trial';

const guard = new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
  ...(killSwitchEnabled
    ? {
        killSwitch: {
          tenant: 'acme',
          agent: 'billing-bot',
          baseUrl: 'https://www.anterislab.com',
          apiKey: process.env.ANTERISLAB_KILLSWITCH_KEY,
        },
      }
    : {}),
});
```

## Do I need a subscription to develop?

No. The SDK ships with a public mock for tests and local development. No
subscription, no API key, no network.

```js
import { Guard } from '@anterislab/guard';
import { createMockFetch, approvedVerdict } from '@anterislab/guard/mock';

const mock = createMockFetch({ status: 200, body: approvedVerdict() });
const guard = new Guard({ apiKey: 'test-key', fetchImpl: mock.fetch });
```

See [testing.md](testing.md) for the full mock API. Use the trial when you
want to evaluate the SDK against the real control plane, with your own
policies.

## Error classes related to subscription

| Class | `code` | Meaning |
|---|---|---|
| `GuardQuotaError` | `GUARD_QUOTA_EXCEEDED` | `402`. Quota exhausted, or trial expired. |
| `GuardAuthError` | `GUARD_UNAUTHORIZED` (401) / `GUARD_FORBIDDEN` (403) | Invalid API key, or agent out of scope for the plan. |

See [error-handling.md](error-handling.md) for the recommended reaction to
each.

## See also

- [Quick start](quick-start.md) — start with the mock, no subscription
  required.
- [Error handling](error-handling.md) — how to react to `402` and `401`/`403`.
- [Kill switch](kill-switch.md) — the feature that requires a paid plan.
