#!/usr/bin/env bash
# Avvio in sviluppo, un comando solo.
#
# Perche' esiste: la sequenza corretta (copia .env, compila il SDK, compila il server, carica la
# policy) ha quattro passi che si dimenticano sempre il primo giorno. Qui sono in ordine, e se un
# passo fallisce lo script si ferma invece di far partire un server mezzo configurato.
#
# Funziona identico su Debian, macOS e Termux: nessuna dipendenza oltre a `node` e `npm`.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail 'node non trovato. Installa Node 18+ (vedi la guida, sezione Termux).'
node -e 'const [maj]=process.versions.node.split(".").map(Number); if (maj<18) { console.error(`serve Node >= 18, trovato ${process.versions.node}`); process.exit(1); }'
info "Node $(node --version)"

# 1. .env
if [ ! -f .env ]; then
  cp .env.example .env
  warn '.env creato da .env.example. In modalita ANTERISLAB_DEV=1 i valori vuoti sono accettabili.'
fi

# 2. Carica .env nell'ambiente, se presente.
#    L'apice singolo nel file e' obbligatorio per i valori JSON: senza, bash rimuove le virgolette
#    interne e il JSON diventa invalido (e l'errore che si vede e' "deve essere un array JSON").
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# 3. In sviluppo, una PRINCIPALS ancora segnaposto vale come "non configurata": meglio generare la
#    credenziale demo che partire con una chiave finta che nessuno conosce.
if [ "${ANTERISLAB_DEV:-0}" = '1' ] && printf '%s' "${ANTERISLAB_KS_PRINCIPALS:-}" | grep -q 'SOSTITUISCI-CON-32-CARATTERI-CASUALI'; then
  warn 'ANTERISLAB_KS_PRINCIPALS contiene ancora il segnaposto: uso la credenziale di sviluppo.'
  unset ANTERISLAB_KS_PRINCIPALS
fi

# 3. Dipendenze e compilazione. `npm ci` se c'e' un lockfile (riproducibile), altrimenti `install`.
install_pkg() {
  local dir="$1"
  info "dipendenze: $dir"
  if [ -f "$dir/package-lock.json" ]; then
    (cd "$dir" && npm ci --no-audit --no-fund >/dev/null)
  else
    (cd "$dir" && npm install --no-audit --no-fund >/dev/null)
  fi
}

if [ ! -d guard/node_modules ]; then install_pkg guard; fi
if [ ! -d server/node_modules ]; then install_pkg server; fi

info 'compilazione SDK'
(cd guard && npm run build >/dev/null)
info 'compilazione control plane'
(cd server && npm run build >/dev/null)

# 4. Il server deve avere almeno un tenant con un piano, altrimenti il primo /evaluate risponde 402
#    per un motivo che sembra un bug e non lo e'.
if [ -z "${ANTERISLAB_KS_PRINCIPALS:-}" ]; then
  warn 'ANTERISLAB_KS_PRINCIPALS vuota: uso la credenziale di sviluppo (tenant demo-tenant).'
  export ANTERISLAB_DEV=1
fi

info 'avvio del control plane su http://127.0.0.1:8787'
infoline=''
if [ "${ANTERISLAB_DEV:-0}" = '1' ]; then
  infoline='modalita sviluppo: chiavi effimere, credenziale dev-operator-key-000000000000, dashboard su /dashboard'
fi
[ -n "$infoline" ] && warn "$infoline"

exec node server/dist/main.js
