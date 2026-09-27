
#!/usr/bin/env bash
# Development startup, a single command.
#
# Why this exists: the correct sequence (copy .env, build the SDK, build the server, load the
# policy) has four steps that everyone forgets on the first day. Here they are in order, and if a
# step fails the script stops instead of starting a half-configured server.
#
# Works identically on Debian, macOS and Termux: no dependencies other than `node` and `npm`.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail 'node not found. Install Node 18+ (see the guide, Termux section).'
node -e 'const [maj]=process.versions.node.split(".").map(Number); if (maj<18) { console.error(`need Node >= 18, found ${process.versions.node}`); process.exit(1); }'
info "Node $(node --version)"

# 1. .env
if [ ! -f .env ]; then
  cp .env.example .env
  warn '.env created from .env.example. In ANTERISLAB_DEV=1 mode, empty values are acceptable.'
fi

# 2. Load .env into the environment, if present.
#    The single quotes in the file are mandatory for JSON values: without them, bash strips
#    the inner quotes and the JSON becomes invalid (and the error you see is "must be a JSON array").
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# 3. In development, a PRINCIPALS still containing the placeholder counts as "not configured":
#    better to generate the demo credential than to start with a fake key nobody knows.
if [ "${ANTERISLAB_DEV:-0}" = '1' ] && printf '%s' "${ANTERISLAB_KS_PRINCIPALS:-}" | grep -q 'REPLACE-WITH-32-RANDOM-CHARACTERS'; then
  warn 'ANTERISLAB_KS_PRINCIPALS still contains the placeholder: using the development credential.'
  unset ANTERISLAB_KS_PRINCIPALS
fi

# 3. Dependencies and build. `npm ci` if a lockfile exists (reproducible), otherwise `install`.
install_pkg() {
  local dir="$1"
  info "dependencies: $dir"
  if [ -f "$dir/package-lock.json" ]; then
    (cd "$dir" && npm ci --no-audit --no-fund >/dev/null)
  else
    (cd "$dir" && npm install --no-audit --no-fund >/dev/null)
  fi
}

if [ ! -d guard/node_modules ]; then install_pkg guard; fi
if [ ! -d server/node_modules ]; then install_pkg server; fi

info 'building SDK'
(cd guard && npm run build >/dev/null)
info 'building control plane'
(cd server && npm run build >/dev/null)

# 4. The server must have at least one tenant with a plan, otherwise the first /evaluate responds
#    402 for a reason that looks like a bug but is not.
if [ -z "${ANTERISLAB_KS_PRINCIPALS:-}" ]; then
  warn 'ANTERISLAB_KS_PRINCIPALS is empty: using the development credential (tenant demo-tenant).'
  export ANTERISLAB_DEV=1
fi

info 'starting the control plane on http://127.0.0.1:8787'
infoline=''
if [ "${ANTERISLAB_DEV:-0}" = '1' ]; then
  infoline='development mode: ephemeral keys, dev-operator-key-000000000000 credential, dashboard at /dashboard'
fi
[ -n "$infoline" ] && warn "$infoline"

exec node server/dist/main.js
