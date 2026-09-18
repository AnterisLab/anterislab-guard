#!/usr/bin/env bash
# Pubblica il SDK. Ogni passo e' un cancello: se uno fallisce, la pubblicazione non avviene.
#
# Perche' cosi' tanti controlli: la 0.1.1 e' finita su npm con un artefatto che NON era la build del
# sorgente revisionato (mancava la gestione del 402). Il modo di non ripetere quell'errore non e'
# "stare piu' attenti", e' mettere un comando che FALLISCE quando artefatto e sorgente divergono.
#
# Uso: TAG=v0.2.0 bash scripts/release-sdk.sh

set -euo pipefail

cd "$(dirname "$0")/.."
TAG="${TAG:-}"
DRY="${DRY:-0}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

[ -n "$TAG" ] || fail 'TAG non impostato. Esempio: TAG=v0.2.0 bash scripts/release-sdk.sh'
node -e 'const [maj]=process.versions.node.split(".").map(Number); if (maj<18) process.exit(1)' || fail 'serve Node >= 18'


info '1/7 albero di lavoro pulito'
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  fail 'ci sono modifiche non committate: pubblicare da un albero sporco rende impossibile ricostruire il contenuto pubblicato'
fi

info '2/7 versione allineata al tag'
VERSION=$(node -p "require('./package.json').version")
EXPECTED="${TAG#v}"
[ "$VERSION" = "$EXPECTED" ] || fail "package.json dice $VERSION ma il tag dice $EXPECTED"

info '3/7 installazione riproducibile'
npm ci --no-audit --no-fund >/dev/null

info '4/7 test'
npm test >/dev/null || fail 'i test non passano'

info '5/7 artefatto == sorgente (ricostruzione e confronto byte a byte)'
node scripts/check-artifact.mjs

info '6/7 contenuto del pacchetto'
npm pack --dry-run 2>&1 | tee ./.release-tmp/pack-contents.txt
for required in 'dist/index.js' 'dist/index.d.ts' 'LICENSE' 'README.md'; do
  grep -q "$required" ./.release-tmp/pack-contents.txt || fail "il pacchetto non conterrebbe $required"
done

info '7/7 pubblicazione'
if [ "$DRY" = '1' ]; then
  echo 'DRY=1: pubblicazione simulata, nessun invio al registro.'
else
  npm publish --access public
fi

info "fatto: @anterislab/guard@$VERSION"
