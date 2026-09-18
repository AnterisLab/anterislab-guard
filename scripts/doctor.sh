#!/usr/bin/env bash
# Dottore: dice se questo ambiente puo' far girare il kit, e se no perche'.
#
# Perche' esiste: il difetto D12 produce un sintomo che sembra un problema di password
# ("sessione assente o scaduta") mentre la causa e' che la cartella del file di sessione non
# esiste. Diagnosi sbagliata, ore perse. Questo script separa le due cose: prova ogni
# prerequisito e, quando qualcosa non va, dice il comando esatto per sistemarlo.
#
# Uso:
#   bash scripts/doctor.sh
#
# Esce 0 se tutto e' a posto, 1 se qualcosa manca. Non modifica nulla, tranne creare la
# cartella di stato se non esiste (ed e' cio' che serve).

set -uo pipefail

cd "$(dirname "$0")/.."

ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$1"; }
bad()  { printf '\033[1;31m[x]\033[0m %s\n' "$1"; }
info() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
fix()  { printf '      \033[1;33msoluzione:\033[0m %s\n' "$1"; }

problemi=0

printf '\n'; info 'Dottore di AnterisLab — controllo dei prerequisiti'; printf '\n'

# ------------------------------------------------------------------ 1. sistema
# Termux o no? Cambia i comandi di installazione che suggeriamo.
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; then
  AMBIENTE='Termux (Android)'
else
  AMBIENTE="$(uname -s)"
fi
ok "ambiente: $AMBIENTE"

# ------------------------------------------------------------------ 2. node
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version)"
  NODE_MAJ="$(printf '%s' "$NODE_V" | sed 's/^v//' | cut -d. -f1)"
  if [ "${NODE_MAJ:-0}" -ge 18 ] 2>/dev/null; then
    ok "node: $NODE_V"
  else
    bad "node: $NODE_V — serve la 18 o superiore"
    if [ "$AMBIENTE" = 'Termux (Android)' ]; then fix 'pkg install -y nodejs'; else fix 'installa Node 18+ da https://nodejs.org'; fi
    problemi=$((problemi + 1))
  fi
else
  bad 'node: non trovato'
  if [ "$AMBIENTE" = 'Termux (Android)' ]; then fix 'pkg install -y nodejs'; else fix 'installa Node 18+ da https://nodejs.org'; fi
  problemi=$((problemi + 1))
fi

# ------------------------------------------------------------------ 3. npm e curl
for cmd in npm curl; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd: $(command -v "$cmd")"
  else
    bad "$cmd: non trovato"
    if [ "$AMBIENTE" = 'Termux (Android)' ]; then fix "pkg install -y $cmd"; else fix "sudo apt install -y $cmd"; fi
    problemi=$((problemi + 1))
  fi
done

# ------------------------------------------------------------------ 4. bash
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ] 2>/dev/null; then
  ok "bash: $BASH_VERSION"
else
  bad "bash: ${BASH_VERSION:-sconosciuta} — serve la 4 o superiore"
  problemi=$((problemi + 1))
fi

# ------------------------------------------------------------------ 5. cartella di stato
# E' IL controllo che risolve il sintomo "sessione assente o scaduta".
printf '\n'
info 'Cartella di stato (dove finisce il file della sessione)'

scelta=''
for candidate in "${ANTERISLAB_STATE_DIR:-}" "$HOME/.anterislab" "${TMPDIR:-}/anterislab" "/tmp/anterislab"; do
  [ -n "$candidate" ] || continue
  if ! mkdir -p "$candidate" 2>/dev/null; then
    bad "$candidate — non riesco a crearla"
    continue
  fi
  if { : > "$candidate/.scrivi-prova"; } 2>/dev/null; then
    rm -f "$candidate/.scrivi-prova" 2>/dev/null
    ok "$candidate — esiste e ci si scrive"
    scelta="$candidate"
    break
  fi
  bad "$candidate — esiste ma non ci si puo' scrivere"
done

if [ -z "$scelta" ]; then
  bad 'nessuna cartella scrivibile trovata'
  fix 'export ANTERISLAB_STATE_DIR="$HOME/anterislab-stato" && mkdir -p "$ANTERISLAB_STATE_DIR"'
  problemi=$((problemi + 1))
fi

# Il caso che inganna: /tmp. Su Termux NON esiste, e curl non lo crea.
if [ ! -d /tmp ]; then
  printf '\n'
  info "Nota: su questo sistema /tmp NON esiste (e' normale su Termux)"
  printf '      I comandi che scrivono in /tmp non funzionano e NON lo dicono.\n'
  printf '      Il file di sessione va in: %s\n' "${scelta:-$HOME/.anterislab}"
fi

STATE_DIR="$scelta"
CK="${CK:-$STATE_DIR/cookie.txt}"

# ------------------------------------------------------------------ 6. kit
printf '\n'
info 'Contenuto del kit'
for f in guard/package.json server/package.json server/dashboard/index.html scripts/dev.sh; do
  if [ -f "$f" ]; then ok "$f"; else bad "$f mancante — kit incompleto"; problemi=$((problemi + 1)); fi
done

# Kit vecchio: lo script di sintassi e' nato nella 0.2.1. Se manca, questo e' un kit vecchio.
if [ -f scripts/check-scripts.sh ]; then
  ok 'scripts/check-scripts.sh presente (kit aggiornato)'
else
  bad 'scripts/check-scripts.sh mancante — stai usando un kit precedente alla 0.2.1'
  fix 'scarica di nuovo il kit dalla guida aggiornata'
  problemi=$((problemi + 1))
fi

# ------------------------------------------------------------------ 7. server
printf '\n'
info 'Control plane'
PORT="${ANTERISLAB_PORT:-8787}"
if [ -f .env ]; then
  ENV_PORT="$(sed -n 's/^ANTERISLAB_PORT=\(.*\)$/\1/p' .env | tail -n 1)"
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
  ok ".env presente (porta $PORT)"
else
  printf '\033[1;33m[!]\033[0m .env assente — verra creato da scripts/dev.sh\n'
fi
BASE="http://127.0.0.1:$PORT"

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/v1/killswitch/health" 2>/dev/null || printf '000')"
if [ "$CODE" = '200' ]; then
  ok "server in ascolto su $BASE (health 200)"

  # Il test che vale: la sessione si SALVA davvero?
  printf '\n'
  info 'Prova di salvataggio della sessione (il test che smaschera D12)'
  PASSWORD="${ANTERISLAB_DASHBOARD_PASSWORD:-}"
  if [ -z "$PASSWORD" ] && [ -f .env ]; then
    PASSWORD="$(sed -n 's/^ANTERISLAB_DASHBOARD_PASSWORD=\(.*\)$/\1/p' .env | tail -n 1)"
  fi
  [ -z "$PASSWORD" ] && PASSWORD='anterislab-dev'

  rm -f "$CK"
  LOGIN="$(curl -s -c "$CK" -X POST "$BASE/api/v1/dashboard/login" \
    -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}" 2>/dev/null)"
  if [ ! -s "$CK" ]; then
    bad "il login ha risposto ma il file di sessione NON e' stato scritto: $CK"
    printf '      risposta del server: %s\n' "$LOGIN"
    fix 'la cartella del file di sessione non e scrivibile — vedi la sezione sopra'
    problemi=$((problemi + 1))
  elif grep -q 'anterislab_sess' "$CK"; then
    ok "sessione salvata in $CK"
    SUMMARY_CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" "$BASE/api/v1/dashboard/summary?tenant=demo-tenant")"
    if [ "$SUMMARY_CODE" = '200' ]; then
      ok 'la sessione viene accettata dal server (summary 200)'
    else
      bad "il server rifiuta la sessione appena creata (summary HTTP $SUMMARY_CODE)"
      problemi=$((problemi + 1))
    fi
  else
    bad 'il file di sessione esiste ma non contiene il cookie: password errata?'
    printf '      risposta del server: %s\n' "$LOGIN"
    problemi=$((problemi + 1))
  fi
else
  printf '\033[1;33m[!]\033[0m nessun server su %s (health %s)\n' "$BASE" "$CODE"
  printf '      avvialo in un altro terminale con: bash scripts/dev.sh\n'
fi

# ------------------------------------------------------------------ esito
printf '\n'
if [ "$problemi" -eq 0 ]; then
  printf '\033[1;32mTutto a posto. Avvia con: bash scripts/dev.sh\033[0m\n\n'
  exit 0
fi
printf '\033[1;31m%s problema/i da risolvere (vedi le righe "soluzione" sopra).\033[0m\n\n' "$problemi"
exit 1
