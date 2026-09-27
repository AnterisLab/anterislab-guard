# Security Policy

AnterisLab Guard is a security product. We take vulnerabilities in it seriously
and we ask you to do the same: please do not open public issues for security
problems.

## Reporting a Vulnerability

Email **security@anterislab.com** with:

- A description of the issue and its potential impact.
- Steps to reproduce, or a proof of concept.
- The affected version (`npm ls @anterislab/guard` or the version in your
  `package.json`).
- Your name and how you would like to be credited, if you want to be credited.

Do not include live API keys, tenant identifiers, or other secrets belonging to
a third party. If a reproduction requires a secret, describe the shape of the
secret and provide a synthetic equivalent.

If you prefer, you can also use GitHub's [private vulnerability reporting][gh-pvr]
on the repository.

[gh-pvr]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

## What to Expect

| Step                        | Timeframe           |
| --------------------------- | ------------------- |
| Acknowledgement of receipt  | within 72 hours     |
| Initial assessment          | within 7 days       |
| Fix or mitigation plan      | within 30 days      |
| Public disclosure           | coordinated with you |

We will keep you informed of our progress at each step. If we determine that
the report is not a vulnerability in scope (see below), we will explain why.

## Coordinated Disclosure

We follow coordinated disclosure. Once a fix is available and released, we will
publish a security advisory on GitHub and credit the reporter (unless they
prefer to remain anonymous). We ask that you do not disclose the issue publicly
before the advisory is published.

If we cannot agree on a disclosure timeline, we will default to 90 days after
the initial acknowledgement.

## Scope

### In scope

The published `@anterislab/guard` package and the source in this repository,
including:

- **Verdict handling** — anything that lets a `BLOCKED`, `PAUSED`, or
  unrecognized response be treated as authorizing, or that makes an authorized
  action not run.
- **Signature verification** — anything that lets an unsigned or invalidly
  signed verdict be accepted when `verifyVerdict` is configured, including
  HMAC comparison timing issues.
- **Kill switch** — anything that lets a signed HALTED state be ignored, a
  local halt be silently cleared, a stale state be treated as fresh, or an
  epoch rollback be accepted.
- **Transport** — anything that leaks the API key (URLs, bodies, error
  messages, logs), bypasses the allowed-host constraint, bypasses the timeout,
  or retries a terminal status (401, 402, 403, 409).
- **Fail-closed guarantees** — anything that turns a documented fail-closed
  path into fail-open without the explicit `failOpen: true` opt-in.
- **TOCTOU windows** — anything that lets a halt arriving during evaluation
  fail to stop the action.

### Out of scope

- Vulnerabilities in the **control plane** (the service at `anterislab.com`).
  These are welcome at the same address but are handled under a separate
  process; this document covers the client SDK.
- Vulnerabilities in **third-party dependencies**. If the issue is in a
  dependency we use, please report it upstream. We will still track it and
  update when a fix is available.
- **Denial of service** through resource exhaustion on the client (for
  example, an agent that runs out of memory because it was given a large
  payload). The SDK enforces bounds on its own inputs; whether the agent can
  be overwhelmed by its own data is the agent's responsibility.
- **Social engineering**, physical attacks, or attacks requiring a
  compromised device.
- **Issues that require the attacker to already control the API key or the
  control plane's signing keys.** These are assumed to be secrets; if they
  leak, the incident is not an SDK vulnerability.
- **Best-practice suggestions** (missing headers, lint warnings, style) — open
  a regular issue or a PR instead.

## Bug Bounty

We do not currently run a paid bug bounty program. We credit researchers in
the published advisory and in the repository's release notes, and we are
grateful for every report.

## Safe Harbor

We will not pursue legal action against researchers who:

- Act in good faith and follow this policy.
- Test only against their own accounts and infrastructure, or against
  AnterisLab infrastructure with prior written authorization.
- Do not exfiltrate data, do not degrade service for others, and do not
  publicly disclose the issue before the coordinated disclosure date.

## Security Model

A detailed threat model, including what the SDK protects against and what it
does not, is documented in [docs/security-model.md](docs/security-model.md).
