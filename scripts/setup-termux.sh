
#!/data/data/com.termux/files/usr/bin/bash
# Bootstrap from scratch on Android/Termux.
#
# Why this exists: on Termux there is no system `node`, no `git` by default, and some packages
# have different names than on Debian. This script runs the three steps in the right order and verifies the result.
#
# Usage:
#   pkg install -y curl
#   bash scripts/setup-termux.sh

set -euo pipefail

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

if [ -z "${TERMUX_VERSION:-}" ] && [ ! -d /data/data/com.termux ]; then
  fail 'This script requires Termux. On Linux or macOS use scripts/dev.sh.'
fi

info 'updating the package index'
pkg update -y >/dev/null 2>&1 || true

info 'installing: nodejs, git, curl'
pkg install -y nodejs git curl >/dev/null

info "Node $(node --version) / npm $(npm --version)"

# On Termux `npm ci` may rebuild native dependencies: there are none here (zero runtime dependencies),
# so the install is fast even on a phone.
info 'installing development dependencies'
(cd "$(dirname "$0")/../guard" && npm install --no-audit --no-fund >/dev/null)
(cd "$(dirname "$0")/../server" && npm install --no-audit --no-fund >/dev/null)

info 'build'
(cd "$(dirname "$0")/../guard" && npm run build >/dev/null)
(cd "$(dirname "$0")/../server" && npm run build >/dev/null)

info 'running tests'
(cd "$(dirname "$0")/../guard" && node --test test/*.test.mjs >/dev/null)
(cd "$(dirname "$0")/../server" && node --test test/*.test.mjs >/dev/null)

info 'bootstrap complete. Start with: bash scripts/dev.sh'
