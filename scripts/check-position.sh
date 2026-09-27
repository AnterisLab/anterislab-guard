
#!/usr/bin/env bash
# Tells you WHERE YOU ARE, WHERE YOU SHOULD BE, and what to do to get back there.
#
# Why this exists (defect K13):
#   Section 6.2 of the guide contained
#       cd ../server && npm install && npm run build
#   which leaves the terminal INSIDE the server/ folder. Section 7.3 then says
#       source scripts/anterislab-env.sh
#   and from inside server/ that path does NOT exist: there is a scripts/, but it is the
#   control plane's (it only contains verify-guarantees.mjs).
#
#   The resulting message is this, and it is IDENTICAL to the one for a missing file:
#       bash: scripts/anterislab-env.sh: No such file or directory
#
#   The file exists, the kit is complete, and the permissions are correct: you are just
#   one level below. This script says so in one line, instead of leaving you to figure it out.
#
# Usage, from ANY folder:
#     bash scripts/check-position.sh
# or, if you are lost and cannot even find the script:
#     bash "$(find ~ -maxdepth 4 -name check-position.sh 2>/dev/null | head -n1)"

set -uo pipefail

ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$1"; }
bad()  { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$1"; }
info() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }

# --- 1. What is the kit root? ----------------------------------------------
# A folder is the root if it contains guard/ AND server/ AND scripts/dev.sh.
# It does not rely on the folder name: someone who renames it to "anterislab" or "stack"
# must not break anything.
is_root() {
  [ -d "$1/guard" ] && [ -d "$1/server" ] && [ -f "$1/scripts/dev.sh" ]
}

# Walk up from the script's path (works even if you launch it from elsewhere).
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"

if ! is_root "$ROOT"; then
  # Edge case: the script was copied outside the kit. Look for the root around us.
  ROOT=''
  for c in "$PWD" "$PWD/.." "$PWD/../.." "$SELF_DIR/.." "$HOME"; do
    if is_root "$c"; then ROOT="$(cd "$c" && pwd)"; break; fi
  done
fi

info "Position"
printf '    Current folder:    %s\n' "$PWD"
if [ -n "$ROOT" ]; then
  printf '    Kit root:          %s\n' "$ROOT"
  if [ "$PWD" = "$ROOT" ]; then
    ok "You are in the kit root: commands with scripts/... work."
  else
    warn "You are OUTSIDE the kit root."
    printf '    The guide commands that start with  scripts/...  do NOT work from here.\n'
    printf '    Return to the root with:\n\n'
    printf '        cd "%s"\n' "$ROOT"
  fi
else
  bad "Cannot find the kit root: I need a folder with guard/, server/ and scripts/dev.sh."
  printf '    Look for it with:\n'
  printf '        find ~ -maxdepth 4 -name dev.sh -path "*/scripts/*" 2>/dev/null\n'
  exit 1
fi

# --- 2. Does the folder you are in have its own scripts/? ------------------
# This is the exact trap: server/scripts/ exists, so a plain ls raises no suspicion,
# but its contents are something else entirely.
if [ -d "$PWD/scripts" ] && [ "$PWD" != "$ROOT" ]; then
  printf '\n'
  warn "This folder has its own scripts/, but it is not the kit's."
  printf '    Contents:\n'
  ls -1 "$PWD/scripts" 2>/dev/null | sed 's/^/        /'
  printf '    The guide scripts are instead in:  %s/scripts\n' "$ROOT"
fi

# --- 3. Are all expected scripts present? ----------------------------------
info "Kit files"
MISSING=0
for f in scripts/anterislab-env.sh scripts/doctor.sh scripts/dashboard-check.sh \
         scripts/check-position.sh scripts/dev.sh scripts/check-scripts.sh; do
  if [ -f "$ROOT/$f" ]; then
    ok "$f"
  else
    bad "$f  MISSING"
    MISSING=$((MISSING+1))
  fi
done

if [ "$MISSING" -gt 0 ]; then
  printf '\n'
  bad "$MISSING files missing: you are using an OLD kit."
  printf '    The kit with the diagnostic scripts is version 2.2 or later.\n'
  printf '    Download the updated kit from the guide, or check that you extracted the whole zip.\n'
  exit 1
fi

# --- 4. Execution permissions ----------------------------------------------
# Defect K14: the four scripts added in 2.2 ended up in the zip with mode 644,
# while the originals were 755. "bash script.sh" works anyway, but "./script.sh"
# gives "Permission denied" and looks like a system problem. Better to say it here.
info "Permissions"
NOEXEC=0
for f in "$ROOT"/scripts/*.sh; do
  [ -f "$f" ] || continue
  if [ ! -x "$f" ]; then
    NOEXEC=$((NOEXEC+1))
    printf '    %s  (mode %s)\n' "$(basename "$f")" "$(stat -c '%a' "$f" 2>/dev/null || echo '?')"
  fi
done
if [ "$NOEXEC" -eq 0 ]; then
  ok "All scripts are executable."
else
  warn "$NOEXEC scripts do not have the execute permission."
  printf '    This is not an error, but ./script.sh will fail with Permission denied.\n'
  printf '    Two ways, both valid:\n'
  printf '        bash <script>                       (always, no permissions needed)\n'
  printf '        chmod +x "%s"/scripts/*.sh          (once)\n' "$ROOT"
fi

# --- 5. How to proceed -----------------------------------------------------
info "Next command"
printf '    cd "%s"\n' "$ROOT"
printf '    source scripts/anterislab-env.sh\n'
printf '\n'
printf 'The final command must print three lines that start with  ==>  .\n'
