#!/usr/bin/env bash
# Variabili d'ambiente condivise: dove sta la sessione, su quale porta parla il server.
#
# Perche' esiste: la guida usava `/tmp/ck.txt` come percorso del file dei cookie. Su Termux
# `/tmp` NON esiste, e curl non lo crea: `curl -c /tmp/ck.txt` fallisce IN SILENZIO (nessun
# errore, nessun avviso, exit 0) e il file non viene mai scritto. Il login risponde
# `{"ok":true}` e sembra riuscito; il comando successivo risponde
# `{"error":{"code":"unauthenticated","message":"sessione assente o scaduta"}}`.
# E' il difetto D12. Questo file e' la contromisura: un percorso di stato che ESISTE DAVVERO,
# scelto provandolo, mai assunto.
#
# Uso, da un terminale nella cartella del kit:
#
#     source scripts/anterislab-env.sh
#
# Dopo il `source` sono disponibili `$BASE`, `$CK` e i comandi `session-login`, `session-check`,
# `api`. Le variabili sono esportate: valgono anche negli incollaggi successivi della STESSA
# sessione di terminale. Se apri un terminale nuovo, ripeti il `source`.

# --- Porta e host del control plane ---------------------------------------
# `ANTERISLAB_PORT` ha priorita'; il default e' 8787, lo stesso di scripts/dev.sh.
if [ -z "${ANTERISLAB_PORT:-}" ] && [ -f .env ]; then
  ANTERISLAB_PORT="$(sed -n 's/^ANTERISLAB_PORT=\(.*\)$/\1/p' .env | tail -n 1)"
fi
ANTERISLAB_PORT="${ANTERISLAB_PORT:-8787}"
export ANTERISLAB_PORT
export BASE="${BASE:-http://127.0.0.1:${ANTERISLAB_PORT}}"

# --- Cartella di stato -----------------------------------------------------
# Ordine di preferenza:
#   1. ANTERISLAB_STATE_DIR, se l'utente l'ha impostata
#   2. $HOME/.anterislab   <- il default, e l'unico che funziona identico su Linux, macOS e Termux
#   3. $TMPDIR/anterislab  <- Termux/Android: la cartella temporanea vera
#   4. /tmp/anterislab     <- ultima spiaggia, solo dove /tmp esiste
#
# Il candidato viene ACCETTATO solo se ci si riesce davvero a scrivere un file: la verifica
# e' una scrittura reale, non un `test -d`. Su Android `test -w` puo' mentire.
_anterislab_pick_state_dir() {
  local candidate
  for candidate in "${ANTERISLAB_STATE_DIR:-}" "$HOME/.anterislab" "${TMPDIR:-}/anterislab" "/tmp/anterislab"; do
    [ -n "$candidate" ] || continue
    mkdir -p "$candidate" 2>/dev/null || continue
    if { : > "$candidate/.scrivi-prova"; } 2>/dev/null; then
      rm -f "$candidate/.scrivi-prova" 2>/dev/null
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! ANTERISLAB_STATE_DIR="$(_anterislab_pick_state_dir)"; then
  printf '\033[1;31m[x]\033[0m Nessuna cartella scrivibile per la sessione.\n' >&2
  printf '    Prova:  export ANTERISLAB_STATE_DIR="$HOME/anterislab-stato" && mkdir -p "$ANTERISLAB_STATE_DIR"\n' >&2
  return 1 2>/dev/null || exit 1
fi
export ANTERISLAB_STATE_DIR

# --- File dei cookie -------------------------------------------------------
export CK="${CK:-$ANTERISLAB_STATE_DIR/cookie.txt}"

printf '\033[1;36m==>\033[0m Control plane:     %s\n' "$BASE"
printf '\033[1;36m==>\033[0m Cartella di stato: %s\n' "$ANTERISLAB_STATE_DIR"
printf '\033[1;36m==>\033[0m File di sessione:  %s\n' "$CK"

# --- Comandi di comodo -----------------------------------------------------

# Apre la sessione e VERIFICA che il cookie sia stato scritto davvero.
# E' la differenza che conta rispetto a un `curl -c` nudo: qui il silenzio di curl non inganna.
session-login() {
  local password="${1:-${ANTERISLAB_DASHBOARD_PASSWORD:-anterislab-dev}}"
  local body
  rm -f "$CK"
  body="$(curl -s -c "$CK" -X POST "$BASE/api/v1/dashboard/login" \
    -H 'content-type: application/json' \
    -d "{\"password\":\"$password\"}") " || return 1
  printf '%s\n' "$body"
  if [ ! -s "$CK" ]; then
    printf '\033[1;31m[x]\033[0m Il server ha risposto, ma il file di sessione NON e stato scritto: %s\n' "$CK" >&2
    printf '    Causa tipica: la cartella non esiste o non e scrivibile (su Termux /tmp non esiste).\n' >&2
    printf '    Diagnosi: bash scripts/doctor.sh\n' >&2
    return 1
  fi
  if ! grep -q 'anterislab_sess' "$CK"; then
    printf '\033[1;31m[x]\033[0m Il file di sessione esiste ma non contiene il cookie di accesso.\n' >&2
    printf '    Causa tipica: password errata (la risposta sopra lo dice), oppure un proxy che rimuove Set-Cookie.\n' >&2
    return 1
  fi
  printf '\033[1;32m[v]\033[0m Sessione aperta e salvata in %s\n' "$CK"
}

# Mostra se il file di sessione esiste e se il cookie e' ancora valido.
session-check() {
  if [ ! -s "$CK" ]; then
    printf '\033[1;31m[x]\033[0m Nessun file di sessione in %s\n' "$CK" >&2
    printf '    Fai prima: session-login\n' >&2
    return 1
  fi
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -b "$CK" "$BASE/api/v1/dashboard/summary?tenant=demo-tenant")"
  if [ "$code" = '200' ]; then
    printf '\033[1;32m[v]\033[0m Sessione valida (HTTP %s)\n' "$code"
  else
    printf '\033[1;31m[x]\033[0m Sessione NON valida (HTTP %s)\n' "$code" >&2
    printf '    Fai di nuovo: session-login\n' >&2
    return 1
  fi
}

# Chiamata autenticata, con il cookie SEMPRE allegato.
api() {
  curl -s -b "$CK" "$BASE$1"
}

export -f session-login session-check api 2>/dev/null || true
