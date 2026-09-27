# Contributing to AnterisLab Guard

Thank you for considering a contribution to AnterisLab Guard. This document
explains how to report issues, propose changes, and get your pull request merged.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
By participating, you are expected to uphold this code.

## Security

If you believe you have found a security vulnerability, **do not open a public
issue**. Please follow the process described in [SECURITY.md](SECURITY.md).

## Ways to Contribute

- **Bug reports** — open an issue using the bug report template.
- **Feature requests** — open an issue using the feature request template.
- **Documentation improvements** — pull requests are welcome.
- **Code contributions** — see the workflow below.

## Before You Start

- **Check existing issues and pull requests** to avoid duplicate work.
- **Open an issue first** for any non-trivial change. This lets us agree on the
  design before you invest time in implementation. Security-sensitive changes
  (transport, verdict parsing, kill switch) require a design discussion first.
- **Keep pull requests focused.** One logical change per PR.

## Development Setup

### Requirements

- Node.js 18 or later
- npm

### Install and build

```bash
git clone https://github.com/AnterisLab/anterislab-guard.git
cd anterislab-guard
npm install
npm run build
