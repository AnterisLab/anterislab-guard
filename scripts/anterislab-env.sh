
#!/usr/bin/env bash
# Shared environment variables: where the session lives, on which port the server speaks.
#
# Why this exists: the guide used `/tmp/ck.txt` as the cookie file path. On Termux
# `/tmp` does NOT exist, and curl does not create it: `curl -c /tmp/ck.txt` fails SILENTLY
# (no error, no warning, exit 0) and the file is never written. The login responds
# `{"ok":true}` and looks successful; the next command responds
# `{"error":{"code":"unauthenticated","message":"session missing or expired"}}`.
# This is defect D12. This file is the countermeasure: a state path that REALLY EXISTS,
# chosen by trying it, never assumed.
#
# Usage, from a terminal inside the kit folder:
#
#     source scripts/anterislab-env.sh
#
# After the `source`, `$BASE`, `$CK` and the commands `session-login`, `session-check`,
# `api` are available. The variables are exported: they also hold for subsequent pastes in
# the SAME terminal session. If you open a new terminal, repeat the `source`.

# --- Control-plane port and host ------------------------------------------
# `ANTERISLAB_PORT` takes priority; the default is 8787, the same as scripts/dev.sh.
if [ -z "${ANTERISLAB_PORT:-}" ] && [ -f .env ]; then
  ANTERISLAB_PORT="$(sed -n 's/^ANTERISLAB_PORT=\(.*\)$/\1/p' .env | tail -n 1)"
fi
ANTERISLAB_PORT="${ANTERISLAB_PORT:-8787}"
export ANTERISLAB_PORT
export BASE="${BASE:-http://127.0.0.1:${ANTERISLAB_PORT}}"

# --- State folder ----------------------------------------------------------
# Preference order:
#   1. ANTERISLAB_STATE_DIR, if the user has set it
#   2. $HOME/.anterislab   <- the default, and the only one that behaves identically on Linux, macOS and Termux
#   3. $TMPDIR/anterislab  <- Termux/Android: the real temporary folder
#   4. /tmp/anterislab     <- last resort, only where /tmp exists
#
# A candidate is ACCEPTED only if we can actually write a file into it: the check
# is a real write, not a `test -d`. On Android `test -w` can lie.
_anterislab_pick_state_dir() {
  local candidate
  for candidate in "${ANTERISLAB_STATE_DIR:-}" "$HOME/.anterislab" "${TMPDIR:-}/anterislab" "/tmp/anterislab"; do
    [ -n "$candidate" ] || continue
    mkdir -p "$candidate" 2>/dev/null || continue
    if { : > "$candidate/.write-test"; } 2>/dev/null; then
      rm -f "$candidate/.write-test" 2>/dev/null
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! ANTERISLAB_STATE_DIR="$(_anterislab_pick_state_dir)"; then
  printf '\033[1;31m[x]\033[0m No writable folder for the session.\n' >&2
  printf '    Try:  export ANTERISLAB_STATE_DIR="$HOME/anterislab-state" && mkdir -p "$ANTERISLAB_STATE_DIR"\n' >&2
  return 1 2>/dev/null || exit 1
fi
export ANTERISLAB_STATE_DIR

# --- Cookie file -----------------------------------------------------------
export CK="${CK:-$ANTERISLAB_STATE_DIR/cookie.txt}"

printf '\033[1;36m==>\033[0m Control plane:     %s\n' "$BASE"
printf '\033[1;36m==>\033[0m State folder:      %s\n' "$ANTERISLAB_STATE_DIR"
printf '\033[1;36m==>\033[0m Session file:      %s\n' "$CK"

# --- Convenience commands --------------------------------------------------

# Opens the session and VERIFIES that the cookie was actually written.
# This is the difference that matters compared to a bare `curl -c`: here the silence of curl
# does not fool you.
session-login() {
  local password="${1:-${ANTERISLAB_DASHBOARD_PASSWORD:-anterislab-dev}}"
  local body
  rm -f "$CK"
  body="$(curl -s -c "$CK" -X POST "$BASE/api/v1/dashboard/login" \
    -H 'content-type: application/json' \
    -d "{\"password\":\"$password\"}") " || return 1
  printf '%s\n' "$body"
  if [ ! -s "$CK" ]; then
    printf '\033[1;31m[x]\033[0m The server responded, but the session file was NOT written: %s\n' "$CK" >&2
    printf '    Typical cause: the folder does not exist or is not writable (on Termux /tmp does not exist).\n' >&2
    printf '    Diagnosis: bash scripts/doctor.sh\n' >&2
    return 1
  fi
  if ! grep -q 'anterislab_sess' "$CK"; then
    printf '\033[1;31m[x]\033[0m The session file exists but does not contain the access cookie.\n' >&2
    printf '    Typical cause: wrong password (the response above says so), or a proxy stripping Set-Cookie.\n' >&2
    return 1
  fi
  printf '\033[1;32m[v]\033[0m Session opened and saved in %s\n' "$CK"
}

# Shows whether the session file exists and whether the cookie is still valid.
session-check() {
  if [ ! -s "$CK" ]; then
    printf '\033[1;31m[x]\033[0m No session file in %s\n' "$CK" >&2
    printf '    Run first: session-login\n' >&2
    return 1
  fi
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" "$BASE/api/v1/dashboard/summary?tenant=demo-tenant")"
  if [ "$code" = '200' ]; then
    printf '\033[1;32m[v]\033[0m Valid session (HTTP %s)\n' "$code"
  else
    printf '\033[1;31m[x]\033[0m INVALID session (HTTP %s)\n' "$code" >&2
    printf '    Run again: session-login\n' >&2
    return 1
  fi
}

# Authenticated call, with the cookie ALWAYS attached.
api() {
  curl -s -b "$CK" "$BASE$1"
}

export -f session-login session-check api 2>/dev/null || true
