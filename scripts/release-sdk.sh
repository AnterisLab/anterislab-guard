
#!/usr/bin/env bash
# Publishes the SDK. Every step is a gate: if one fails, the publish does not happen.
#
# Why so many checks: the 0.1.1 landed on npm with an artifact that was NOT the build of the
# reviewed source (the 402 handling was missing). The way not to repeat that mistake is not
# "pay more attention", it is to put a command in place that FAILS when artifact and source diverge.
#
# Usage: TAG=v0.2.0 bash scripts/release-sdk.sh

set -euo pipefail

cd "$(dirname "$0")/.."
TAG="${TAG:-}"
DRY="${DRY:-0}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

[ -n "$TAG" ] || fail 'TAG not set. Example: TAG=v0.2.0 bash scripts/release-sdk.sh'
node -e 'const [maj]=process.versions.node.split(".").map(Number); if (maj<18) process.exit(1)' || fail 'requires Node >= 18'


info '1/7 clean working tree'
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  fail 'there are uncommitted changes: publishing from a dirty tree makes it impossible to reconstruct what was published'
fi

info '2/7 version aligned with the tag'
VERSION=$(node -p "require('./package.json').version")
EXPECTED="${TAG#v}"
[ "$VERSION" = "$EXPECTED" ] || fail "package.json says $VERSION but the tag says $EXPECTED"

info '3/7 reproducible install'
npm ci --no-audit --no-fund >/dev/null

info '4/7 test'
npm test >/dev/null || fail 'the tests do not pass'

info '5/7 artifact == source (rebuild and byte-by-byte comparison)'
node scripts/check-artifact.mjs

info '6/7 package contents'
npm pack --dry-run 2>&1 | tee ./.release-tmp/pack-contents.txt
for required in 'dist/index.js' 'dist/index.d.ts' 'LICENSE' 'README.md'; do
  grep -q "$required" ./.release-tmp/pack-contents.txt || fail "the package would not contain $required"
done

info '7/7 publish'
if [ "$DRY" = '1' ]; then
  echo 'DRY=1: simulated publish, nothing sent to the registry.'
else
  npm publish --access public
fi

info "done: @anterislab/guard@$VERSION"
