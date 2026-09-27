# AnterisLab Guard Documentation

AnterisLab Guard is the open-source client SDK for the AnterisLab policy engine.
Every action an agent takes is evaluated against your policies **before** it
executes, and a stop order actually stops the agent.

The policy engine and the kill switch run in the AnterisLab cloud. This
documentation covers the client side: enforcement, transport, verdict
verification, and kill-switch coordination.

A subscription is required to talk to the production control plane. A 14-day
free tier is available for evaluation. Development and tests do not need a
subscription; see [testing.md](testing.md).

## Getting started

If you are new to AnterisLab Guard, start here:

1. **[Quick start](quick-start.md)** — install the SDK and run your first guarded action.
2. **[Configuration](configuration.md)** — every option `new Guard(...)` accepts.
3. **[Verdicts](verdicts.md)** — what `APPROVED`, `FLAGGED`, `BLOCKED`, and `PAUSED` mean.

## Reference

- **[API reference](api-reference.md)** — every public class, function, and type.
- **[Error handling](error-handling.md)** — the `GuardError` hierarchy and how to react to each.
- **[Kill switch](kill-switch.md)** — local halt, verified control-plane state, SSE stream.

## Guides

- **[Testing](testing.md)** — how to test your agent without a subscription, using the public mock.
- **[Subscription](subscription.md)** — free tier, what happens on expiry, and how to upgrade.

## Security

- **[Security model](security-model.md)** — what the SDK protects against, and what it does not.

For vulnerability reporting, see [SECURITY.md](../SECURITY.md) at the repository root.

## Contributing

For development setup, code standards, and the pull request workflow, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## External links

- **Repository**: <https://github.com/AnterisLab/anterislab-guard>
- **Package (npm)**: <https://www.npmjs.com/package/@anterislab/guard>
- **Website**: <https://anterislab.com>
- **Changelog**: [CHANGELOG.md](../CHANGELOG.md)
