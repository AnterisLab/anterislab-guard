<!--
Thank you for contributing to AnterisLab Guard.
Please fill out this template so the review can be fast and focused.
See CONTRIBUTING.md for the full workflow.
-->

## Description

What does this pull request change, and why?

## Related issue

Closes #<!-- issue number -->

If there is no related issue, explain why this change is being proposed without one.

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation update
- [ ] Refactor (no functional change)
- [ ] Test-only change
- [ ] Build, tooling, or CI change

If **breaking change**, describe the migration path for existing users and
confirm that a major version bump is planned.

## Checklist

- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md).
- [ ] My changes are focused on a single logical change.
- [ ] I have added tests that prove my fix is effective or that my feature works.
- [ ] All new and existing tests pass (`npm test`).
- [ ] Type checking passes (`npm run typecheck`).
- [ ] I have run the formatter/linter (`npx biome check .`), if applicable.
- [ ] I have updated the documentation (README, CHANGELOG, or code comments) where necessary.
- [ ] My commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] I have **not** included any API keys, tokens, or secrets in this pull request.
- [ ] I have not introduced any new runtime dependencies.

## Security considerations

Does this change affect any of the SDK's security guarantees?

- [ ] This touches the transport layer (HTTP, retries, timeout, idempotency).
- [ ] This touches verdict parsing or signature verification.
- [ ] This touches the kill switch.
- [ ] This could affect the fail-closed posture.
- [ ] This changes the public API (exported classes, functions, types).
- [ ] None of the above.

If any box is checked, explain the impact below, including any new edge cases
that are now covered by tests.

## How has this been tested?

Describe the tests you ran, and any manual verification steps. Include relevant
commands and their output if useful.

## Additional notes for reviewers

Anything else the maintainer should know when reviewing this pull request.
