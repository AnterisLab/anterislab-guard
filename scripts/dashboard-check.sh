#!/usr/bin/env bash
# Un comando solo per provare tutta la sezione dashboard della guida.
#
# Perche' esiste: la guida spezzava la prova in cinque blocchi da incollare, e ognuno dipendeva
# da variabili e da un file cookie impostati in un blocco precedente. Chi ne saltava uno otteneva
# un 401 e non aveva modo di sapere perche'. Qui i cinque passi sono in ordine, e ognuno dice
# cosa deve apparire prima di passare al successivo. Se un passo fallisce, lo script si FERMA e
# spiega la causa invece di proseguire con un errore che sembra un'altra cosa.
#
# Uso:
#   bash scripts/dashboard-check.sh
#
# Presuppone il server gia' avviato (bash scripts/dev.sh in un altro terminale).

set -uo pipefail

cd "$(dirname "$0")/.."

ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$1"; }
bad()  { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; }
info() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
fail() { bad "$1"; printf '\n' >&2; exit 1; }

# --- porta e cartella di stato, con le stesse regole di anterislab-env.sh ---
PORT="${ANTERISLAB_PORT:-8787}"
if [ -f .env ]; then
  ENV_PORT="$(sed -n 's/^ANTERISLAB_PORT=\(.*\)$/\1/p' .env | tail -n 1)"
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi
BASE="http://127.0.0.1:$PORT"

STATE_DIR=''
for candidate in "${ANTERISLAB_STATE_DIR:-}" "$HOME/.anterislab" "${TMPDIR:-}/anterislab" "/tmp/anterislab"; do
  [ -n "$candidate" ] || continue
  mkdir -p "$candidate" 2>/dev/null || continue
  if { : > "$candidate/.scrivi-prova"; } 2>/dev/null; then
    rm -f "$candidate/.scrivi-prova" 2>/dev/null
    STATE_DIR="$candidate"
    break
  fi
done
[ -n "$STATE_DIR" ] || fail 'nessuna cartella scrivibile per il file di sessione. Prova: export ANTERISLAB_STATE_DIR="$HOME/anterislab-stato"'
CK="$STATE_DIR/cookie.txt"

PASSWORD="${ANTERISLAB_DASHBOARD_PASSWORD:-}"
if [ -z "$PASSWORD" ] && [ -f .env ]; then
  PASSWORD="$(sed -n 's/^ANTERISLAB_DASHBOARD_PASSWORD=\(.*\)$/\1/p' .env | tail -n 1)"
fi
[ -z "$PASSWORD" ] && PASSWORD='anterislab-dev'

printf '\n\033[1;36m==>\033[0m AnterisLab — prova della dashboard\n'
printf '    server:      %s\n    sessione in: %s\n' "$BASE" "$CK"

# --- 0. il server risponde? ------------------------------------------------
info '0/5  Il server risponde'
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/v1/killswitch/health" 2>/dev/null || printf '000')"
if [ "$CODE" != '200' ]; then
  bad "nessuna risposta da $BASE/api/v1/killswitch/health (HTTP $CODE)"
  printf '      Il server non e in esecuzione, oppure e in ascolto su un altra porta.\n' >&2
  printf '      In un ALTRO terminale:  bash scripts/dev.sh\n' >&2
  printf '      Se hai cambiato porta:  ANTERISLAB_PORT=9787 bash scripts/dev.sh\n' >&2
  printf '      Diagnosi:               bash scripts/doctor.sh\n\n' >&2
  exit 1
fi
ok "il server risponde su $BASE"

# --- 1. login --------------------------------------------------------------
info '1/5  Apertura della sessione'
rm -f "$CK"
LOGIN="$(curl -s -c "$CK" -X POST "$BASE/api/v1/dashboard/login" \
  -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}" 2>/dev/null)"
printf '      risposta: %s\n' "$LOGIN"
case "$LOGIN" in
  *'"ok":true'*) ;;
  *'password errata'*)
    bad 'password errata'
    printf '      In sviluppo la password e anterislab-dev.\n' >&2
    printf '      Se l hai impostata nel .env, usa quella: ANTERISLAB_DASHBOARD_PASSWORD=...\n' >&2
    exit 1 ;;
  *)
    bad "risposta inattesa dal login: $LOGIN"
    exit 1 ;;
esac
ok 'login accettato dal server'

# --- 2. il file di sessione esiste DAVVERO? --------------------------------
info '2/5  Salvataggio della sessione su disco'
if [ ! -s "$CK" ]; then
  bad "il login e riuscito ma il file di sessione NON e stato scritto: $CK"
  printf '\n      Questa e la causa del messaggio "sessione assente o scaduta" che non si spiega.\n' >&2
  printf '      curl NON segnala l errore: esce con 0 e non stampa nulla.\n\n' >&2
  printf '      Succede quando la cartella del file di sessione non esiste o non e scrivibile.\n' >&2
  printf '      Su Termux /tmp NON esiste, quindi -c /tmp/ck.txt fallisce sempre.\n\n' >&2
  printf '      Soluzione: esegui   source scripts/anterislab-env.sh   e usa "$CK".\n' >&2
  printf '      Diagnosi:   bash scripts/doctor.sh\n\n' >&2
  exit 1
fi
if ! grep -q 'anterislab_sess' "$CK"; then
  bad "il file di sessione esiste ma non contiene il cookie: $CK"
  printf '      Contenuto: %s\n' "$(head -c 200 "$CK")" >&2
  printf '      Causa tipica: un proxy ha rimosso Set-Cookie, oppure la sessione e stata azzerata.\n' >&2
  exit 1
fi
ok "file di sessione scritto e valido ($(wc -c < "$CK" | tr -d ' ') byte)"

# --- 3. senza cookie -> 401 ------------------------------------------------
info '3/5  Senza cookie il server deve rifiutare'
NEG="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/dashboard/summary?tenant=demo-tenant")"
if [ "$NEG" = '401' ]; then
  ok 'senza sessione: HTTP 401 (comportamento atteso)'
else
  bad "senza sessione ho ricevuto HTTP $NEG invece di 401"
  exit 1
fi

# --- 4. con cookie -> summary ---------------------------------------------
info '4/5  Con il cookie allegato'
SUMMARY="$(curl -s -b "$CK" "$BASE/api/v1/dashboard/summary?tenant=demo-tenant")"
if printf '%s' "$SUMMARY" | grep -q 'unauthenticated'; then
  bad 'il server ha rifiutato la sessione appena creata'
  printf '      Il file cookie esiste, ma il cookie non viene accettato.\n' >&2
  printf '      Connessione diversa da quella del login? (127.0.0.1 contro localhost)\n' >&2
  printf '      Header inviati:  curl -v -b "%s" "%s/api/v1/dashboard/summary?tenant=demo-tenant"\n' "$CK" "$BASE" >&2
  exit 1
fi
printf '      %s\n' "$(printf '%s' "$SUMMARY" | head -c 160)"
ok 'stato del tenant letto dalla dashboard'

# --- 5. halt e resume ------------------------------------------------------
info '5/5  Fermare e riabilitare un agente'
HALT="$(curl -s -b "$CK" -X POST "$BASE/api/v1/dashboard/halt" \
  -H 'content-type: application/json' \
  -d '{"tenant":"demo-tenant","agent":"billing-bot","reason":"prova dalla guida"}')"
printf '      halt:   %s\n' "$(printf '%s' "$HALT" | head -c 120)"
printf '%s' "$HALT" | grep -q '"ok":true' || fail "halt non riuscito: $HALT"
ok 'agente fermato'

RESUME="$(curl -s -b "$CK" -X POST "$BASE/api/v1/dashboard/resume" \
  -H 'content-type: application/json' \
  -d '{"tenant":"demo-tenant","agent":"billing-bot","reason":"fine prova"}')"
printf '      resume: %s\n' "$(printf '%s' "$RESUME" | head -c 120)"
printf '%s' "$RESUME" | grep -q '"ok":true' || fail "resume non riuscito: $RESUME"
ok 'agente riabilitato'

printf '\n\033[1;32mDashboard verificata: 5 passi su 5.\033[0m\n\n'
