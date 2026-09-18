#!/data/data/com.termux/files/usr/bin/bash
# Bootstrap da zero su Android/Termux.
#
# Perche' esiste: su Termux non c'e' `node` di sistema, non c'e' `git` per default, e alcuni pacchetti
# hanno nomi diversi da Debian. Questo script fa i tre passi nell'ordine giusto e verifica l'esito.
#
# Uso:
#   pkg install -y curl
#   bash scripts/setup-termux.sh

set -euo pipefail

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

if [ -z "${TERMUX_VERSION:-}" ] && [ ! -d /data/data/com.termux ]; then
  fail 'Questo script richiede Termux. Su Linux o macOS usa scripts/dev.sh.'
fi

info 'aggiornamento dell indice dei pacchetti'
pkg update -y >/dev/null 2>&1 || true

info 'installazione: nodejs, git, curl'
pkg install -y nodejs git curl >/dev/null

info "Node $(node --version) / npm $(npm --version)"

# Su Termux `npm ci` puo' ricompilare dipendenze native: qui non ce ne sono (zero dipendenze runtime),
# quindi l'installazione e' veloce anche su telefono.
info 'installazione dipendenze di sviluppo'
(cd "$(dirname "$0")/../guard" && npm install --no-audit --no-fund >/dev/null)
(cd "$(dirname "$0")/../server" && npm install --no-audit --no-fund >/dev/null)

info 'compilazione'
(cd "$(dirname "$0")/../guard" && npm run build >/dev/null)
(cd "$(dirname "$0")/../server" && npm run build >/dev/null)

info 'esecuzione dei test'
(cd "$(dirname "$0")/../guard" && node --test test/*.test.mjs >/dev/null)
(cd "$(dirname "$0")/../server" && node --test test/*.test.mjs >/dev/null)

info 'bootstrap completato. Avvia con: bash scripts/dev.sh'
