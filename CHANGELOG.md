# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-28

First stable release. The 1.0.0 line is the client SDK for the AnterisLab
policy engine, with a complete public surface, published documentation, a
public sandbox for evaluation without a subscription, and CI that enforces
the security guarantees.

### Added

- **Public mock** (`@anterislab/guard/mock`): a zero-dependency `fetch`
  replacement for tests and local development without a subscription. Exposes
  `createMockFetch`, canonical verdict builders (`approvedVerdict`,
  `flaggedVerdict`, `blockedVerdict`, `pausedVerdict`), and `signBody` for
  HMAC-SHA256 signatures in the format `verifyVerdict` expects.
- **Public sandbox**: a fixed public key (`anteris_sandbox_public`) that
  reaches a stateless copy of the policy engine for a first evaluation without
  signup. Rate-limited per IP, no database access, no quota consumption. See
  [docs/testing.md](docs/testing.md#try-it-in-30-seconds-no-signup).
- **Documentation** under `docs/`: quick start, configuration, verdicts,
  error handling, kill switch, testing, subscription, security model, API
  reference, and index.
- **Governance and community files**: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), `SECURITY.md` with coordinated disclosure
  policy, and `CHANGELOG.md`.
- **GitHub templates**: issue forms for bugs and feature requests, plus a
  pull request template with a security checklist.
- **Kill switch test suite** (`test/killswitch.test.mjs`): covers local halt,
  fail-closed posture, verified state, epoch anti-rollback, and the local
  audit trail.
- **CI on GitHub Actions**: test matrix on Node 20, 22, and 24; ESLint lint;
  coverage uploaded to Codecov; `npm audit --audit-level=high` gate.
- **Dependabot**: weekly npm and monthly GitHub Actions updates.

### Changed

- **Breaking: minimum Node.js version raised from 18 to 20.** The kill switch
  uses `globalThis.crypto.subtle` for the local audit chain and for JWS
  signature verification. Node 18 does not expose WebCrypto as a global by
  default; Node 20 does. Node 18 reached end-of-life in April 2025.
- **All user-facing content translated to English**: README, source comments,
  error messages, test descriptions, and fixtures. AnterisLab Guard is an
  international project; English is its primary language.
- `package.json` `homepage` now uses the canonical `https://anterislab.com`
  (non-www) to match `<link rel="canonical">`.
- `package.json` `keywords` extended with `ai-safety` and `fail-closed`.
- `SDK high_VERSION` in `src/index.ts` is now kept in sync with `package.json`.
  The 0.2.x line reported `0.2.0` even after the `0.2.1` release.

### Fixed

- README error-code table now matches the implementation:
  `GUARD_QUOTA_EXCEEDED` (was `GUARD_QUOTA`), `GUARD_UNAUTHORIZED` /
  `GUARD_FORBIDDEN` (was `GUARD_AUTH`), and `GUARD_STALE_POLICY` (was
  `GUARD_POLICY`).
- `scripts/check-artifact.mjs` now reads the entire `dist/` bundle when
  searching for symbols, instead of reading only `index.js`. The previous
  version failed on correct packages because strings live in the emitted file
  of the module that defines them, not necessarily in `index.js`.

### Security

- Continuous `npm audit` in CI blocks and critical vulnerabilities.
- Dependabot enabled for the SDK and for the AnterisLab site.
- AnterisLab site upgraded from Next.js `14.2.35` to `16.3.6` and React 19,
  resolving 22 Next.js advisories (including critical RCE, SSRF, and cache
  poisoning) and 4 PostCSS advisories.

## [0.2.1] - 2026-09-19

### Security

- **Fixed ReDoS in `stripTrailingSlashes`.** The previous implementation used
  an unanchored regular expression vulnerable to catastrophic backtracking on
  input with many repetitions of `/`. The function is now iterative and runs
  in linear time.

## [0.2.0] - 2026-09-18

This release is a security rewrite. The 0.1.x line had fail-open defects in
the verdict path, single-method coverage in `wrap()`, and a transport that
retried terminal statuses and ignored `Retry-After`. The 0.2.0 line replaces
those behaviors with the guarantees documented in the README.

### Added

- **Kill switch** (`KillSwitchManager`): signed JWS state, local halt that
  works with no network, SSE stream for sub-second propagation, and a
  hash-chained local audit trail.
- **Signed verdicts**: optional HMAC verification of the verdict body via
  `verifyVerdict`. An unsigned or invalidly signed positive verdict is
  rejected.
- **Positive allow-list**: only `APPROVED` and `FLAGGED` authorize. Every
  other outcome (unknown word, missing field, non-object body, HTML, truncated
  JSON) is a denial.
- **Anti-TOCTOU re-check**: a halt arriving during policy evaluation stops
  the action even after a positive verdict.
- **Idempotency**: `Idempotency-Key` is generated once per action and reused
  on every retry, so a retry does not consume plan quota twice.
- **`failOpen` option**: explicit opt-in to proceed when the guard is
  unreachable. Never raises a real `APPROVED` and never bypasses a `402`.

### Changed

- **`wrap()` now protects every method** of the wrapped object. Exceptions
  must be declared explicitly in `passthrough`. Previously (0.1.1, defect
  A-01) only one method was protected; a single call site could slip past the
  gate.
- **Verdict parsing treats unrecognized responses as denials.** The 0.1.1
  code read `decision === 'BLOCKED'`, so the documented
  `{ "verdict": "block" }` schema did not match and the action executed
  (defects C-01 / C-02).
- **Transport timeout now covers body reads.** `fetch` resolves as soon as
  the headers arrive; a slow or stalled body read is now bounded by the same
  `timeoutMs` as the request itself (defect M-02).
- **`Retry-After` is honored in full, or the request is rejected.** The
  previous behavior ignored the header, which could turn a rate limit into
  fail-open (defect A-05).
- **Terminal statuses are never retried.** `401`, `402`, `403`, and `409` are
  surfaced to the caller on the first response.

### Fixed

- **API key leakage in responses**: a response body that contains the
  configured API key is rejected before being parsed.
- **Response size limit**: response bodies larger than 256 KiB are rejected.
- **429 no longer pushes the guard to fail-open.** Previously, an unreachable
  service combined with a flood of 429 responses could leave the agent
  effectively unguarded.

## [0.1.2] - 2026-XX-XX

### Changed

- Published the TypeScript type declarations (`types.d.ts`) alongside the
  runtime package, so consumers get type information without relying on the
  source.

## [0.1.1] - 2026-XX-XX

### Notes

- Subsequent patch release. The full contents of this version are not
  preserved in the current codebase. Several defects were identified in
  retrospect and fixed in 0.2.0:
  - **A-01**: `wrap()` protected only the first method of the wrapped object.
  - **A-05 / M-02**: transport ignored `Retry-After` and the timeout did not
    cover the body read.
  - **C-01 / C-02**: verdict parsing read `decision === 'BLOCKED'` (a
    deny-list), so unrecognized responses were treated as authorizing.
- This version had no kill switch and no verdict signature verification.

## [0.1.0] - 2026-XX-XX

### Added

- Initial release.
- `Guard`, `wrap()`, `wrapFn()`.
- Transport to `/api/v1/evaluate`.
- Fail-closed default posture.

---

## About this changelog

The 0.2.0 entry is a reconstruction from the source comments and commit
history of the rewrite. It describes the security guarantees the 0.2.0 line
introduces relative to the 0.1.x line, and the specific defects (labeled
A-01, A-05, M-02, C-01, C-02) that were found during the rewrite and are now
covered by the test suite.

Dates for versions before 0.2.0 are not preserved. Contributions to fill
them in are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

[Unreleased]: https://github.com/AnterisLab/anterislab-guard/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AnterisLab/anterislab-guard/compare/v0.2.1...v1.0.0
[0.2.1]: https://github.com/AnterisLab/anterislab-guard/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AnterisLab/anterislab-guard/releases/tag/v0.2.0
[0.1.2]: https://github.com/AnterisLab/anterislab-guard/releases/tag/v0.1.2
[0.1.1]: https://github.com/AnterisLab/anterislab-guard/releases/tag/v0.1.1
[0.1.0]: https://github.com/AnterisLab/anterislab-guard/releases/tag/v0.1.0
