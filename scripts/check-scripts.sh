
#!/usr/bin/env bash
# Syntax check on ALL shell scripts in the kit.
#
# Why this exists: kit 0.2.0 shipped with `setup-termux.sh` and `release-sdk.sh`
# syntactically INVALID, and we did not notice because no automated check inspected the
# shell scripts. `npm test` does not touch them: the tests cover the TypeScript code, not
# the scripts that start it.
#
# The resulting error was particularly insidious:
#   scripts/setup-termux.sh: line 28: syntax error near unexpected token `('
# pointed at line 28, but the real cause was at line 17: an apostrophe "escaped" with a
# backslash inside single quotes.
#
#   fail 'This script e\' designed for Termux.'
#                       ^^ the backslash is NOT an escape in bash
#
# Bash closes the string at the first single quote. Everything else on the line becomes
# code, and every subsequent line is interpreted from an incorrect quoting state: the error
# is reported much further down than where it was born.
#
# Usage:
#   bash scripts/check-scripts.sh
#
# Exits with code 1 if even a single script fails.

set -euo pipefail

cd "$(dirname "$0")/.."

fail() { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }
ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$1"; }

# bash is mandatory: the scripts declare `#!/usr/bin/env bash` or the Termux path.
command -v bash >/dev/null 2>&1 || fail 'bash not found in PATH'

mapfile -t scripts < <(find . -name '*.sh' -not -path './node_modules/*' \
  -not -path '*/node_modules/*' | sort)

[ "${#scripts[@]}" -gt 0 ] || fail 'no .sh script found: are you in the right folder?'

printf 'Syntax check on %d scripts\n\n' "${#scripts[@]}"

failed=0
for f in "${scripts[@]}"; do
  if err="$(bash -n "$f" 2>&1)"; then
    ok "$f"
  else
    printf '\033[1;31m[x]\033[0m %s\n' "$f"
    printf '%s\n' "$err" | sed 's/^/      /' >&2
    failed=$((failed + 1))
  fi
done

[ "$failed" -eq 0 ] || fail "$failed out of ${#scripts[@]} scripts fail the syntax check"

# Search for the typical cause, even when the syntax currently holds.
# An apostrophe preceded by a backslash inside single quotes is ALWAYS a bug,
# even if the file happens to compile: the message shown to the user will contain an extra
# backslash and the behavior changes as soon as a line is added above or below.
printf '\nSearch for the typical cause (backslash before apostrophe)...\n'
# Comments are excluded on purpose: this very file contains the bad line
# as an example not to imitate, and it is the only legitimate place for it.
if grep -rnF "\\'" --include='*.sh' . 2>/dev/null | grep -v node_modules \
   | grep -vE ':[0-9]+:[[:space:]]*#'; then
  fail 'found an apostrophe escaped with a backslash: in bash it is not an escape. Use double quotes, or drop the apostrophe.'
fi
ok 'no apostrophe escaped with a backslash'

printf '\n\033[1;32mAll scripts pass the syntax check.\033[0m\n'
