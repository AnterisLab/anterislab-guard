#!/usr/bin/env bash
# Test di regressione per il difetto D12: la sessione che "si perde".
#
# Perche' esiste: la guida salvava il cookie di sessione in `/tmp/ck.txt`. In un ambiente dove
# quella cartella non esiste o non e' scrivibile (Termux: `/tmp` NON esiste), `curl -c` FALLISCE
# IN SILENZIO — esce con 0, non stampa nulla, e il file non viene creato. Il login risponde
# `{"ok":true}` e sembra riuscito; il comando successivo risponde
# `{"error":{"code":"unauthenticated","message":"sessione assente o scaduta"}}`.
#
# I 91 test automatici del kit non potevano accorgersene: verificano il TypeScript, non i comandi
# di shell che l'utente incolla. Questo test copre quel buco.
#
# Uso:
#   bash scripts/test-session.sh
#
# Non richiede un server in esecuzione per la parte che conta (la scelta della cartella di stato e
# il comportamento silenzioso di curl). Se un server risponde, esegue anche il ciclo completo.

set -uo pipefail

cd "$(dirname "$0")/.."

ok()    { printf '\033[1;32m[v]\033[0m %s\n' "$1"; }
bad()   { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; }
info()  { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
pass=0
fail=0

printf '\n\033[1;36m==>\033[0m Test di regressione: archiviazione della sessione (D12)\n'

WORK="$(mktemp -d 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/anterislab-test-$$")"
mkdir -p "$WORK" 2>/dev/null
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK" 2>/dev/null' EXIT

# ---------------------------------------------------------------------------
info '1. Il comportamento di curl su cui si basa il difetto'
# ---------------------------------------------------------------------------
# Una cartella che esiste ma su cui non si puo' scrivere. Su Termux e' /tmp.
RO="$WORK/ro"
mkdir -p "$RO"
chmod 555 "$RO"

# Se giriamo come root, il permesso di sola lettura non ci ferma: curl scriverebbe comunque
# e il test non proverebbe nulla. Meglio dirlo che fingere che il test sia passato.
if [ "$(id -u)" = '0' ]; then
  # Anche da root, una cartella che NON ESISTE non e' scrivibile: e' il caso Termux piu' fedele.
  RO="$WORK/non-esiste"
  rm -rf "$RO"
  printf '      (esecuzione come root: uso una cartella INESISTENTE, che nessuno puo creare con curl)\n'
fi

OLD_CK="$RO/ck.txt"
rm -f "$OLD_CK"
# `-c` verso un percorso non scrivibile. Non ci interessa la risposta del server: ci interessa
# cosa fa curl con il file.
curl -s -o /dev/null -c "$OLD_CK" "http://127.0.0.1:1/" 2>/dev/null
CURL_EXIT=$?

if [ -f "$OLD_CK" ]; then
  bad "atteso: curl NON crea il file su percorso non scrivibile, ma l'ha creato ($OLD_CK)"
  fail=$((fail + 1))
else
  ok "curl non crea il file di cookie su percorso non scrivibile (exit=$CURL_EXIT, nessun avviso)"
  pass=$((pass + 1))
fi
[ "$CURL_EXIT" = '0' ] && ok 'confermato: curl esce comunque con 0 — l errore e silenzioso'

# ---------------------------------------------------------------------------
info '2. anterislab-env.sh sceglie una cartella scrivibile DAVVERO'
# ---------------------------------------------------------------------------
# Simuliamo Termux: HOME e TMPDIR che non si possono usare.
STATE="$WORK/state"
OUT="$(cd "$(dirname "$0")/.." && pwd)"
PICKED="$(HOME="$WORK/home-non-esiste" TMPDIR="$RO" ANTERISLAB_STATE_DIR='' \
  bash -c 'cd "'"$OUT"'"; source scripts/anterislab-env.sh >/dev/null 2>&1; printf "%s" "$CK"' 2>/dev/null)"

if [ -z "$PICKED" ]; then
  bad 'anterislab-env.sh non ha prodotto alcun percorso di sessione'
  fail=$((fail + 1))
else
  DIR="$(dirname "$PICKED")"
  if mkdir -p "$DIR" 2>/dev/null && { : > "$DIR/.prova"; } 2>/dev/null; then
    rm -f "$DIR/.prova"
    ok "ha scelto una cartella scrivibile: $PICKED"
    pass=$((pass + 1))
  else
    bad "ha scelto una cartella NON scrivibile: $PICKED"
    fail=$((fail + 1))
  fi

  # La cartella scelta NON deve essere quella inutilizzabile.
  case "$PICKED" in
    "$RO"/*)
      bad "ha scelto la cartella inutilizzabile $RO — la catena di fallback non funziona"
      fail=$((fail + 1)) ;;
    *)
      ok 'ha scartato la cartella inutilizzabile e ne ha trovata un altra'
      pass=$((pass + 1)) ;;
  esac
fi

# ---------------------------------------------------------------------------
info '3. La guida non contiene piu percorsi di stato non garantiti'
# ---------------------------------------------------------------------------
# Il difetto era nel TESTO della guida, quindi il controllo va fatto sul testo.
#
# ATTENZIONE a cosa si cerca: `/tmp/ck.txt` compare LEGITTIMAMENTE nella guida, in due punti
# didattici — la tabella "Se compare un errore" (dove il percorso sbagliato e' citato come
# esempio del messaggio che l'utente vede) e la sezione 7.3.1 (dove la causa e' spiegata).
# Un grep ingenuo segnalerebbe quei passaggi e produrrebbe un falso allarme: e' esattamente il
# tipo di controllo che si impara a ignorare, e un controllo ignorato non protegge nulla.
#
# Cio' che NON deve piu' esistere sono i comandi REALI, cioe' le righe che iniziano con `curl`
# e finiscono in `/tmp/ck.txt`. Quelli sì sarebbero istruzioni da incollare, e su Termux
# fallirebbero in silenzio.
GUIDE_HITS=0
GUIDE_SEEN=0
for guide in ../documents/anterislab-stack-fase5_v4/GUIDA-UNICA-ANTERISLAB.md \
             ../../documents/anterislab-stack-fase5_v4/GUIDA-UNICA-ANTERISLAB.md; do
  [ -f "$guide" ] || continue
  GUIDE_SEEN=1

  # Comandi reali (non citazioni) che scrivono o leggono il cookie in /tmp.
  REALE="$(grep -nE '^[[:space:]]*curl\b[^|]*/tmp/ck\.txt' "$guide" 2>/dev/null || true)"
  if [ -n "$REALE" ]; then
    bad "$(basename "$guide"): comandi che usano ancora /tmp/ck.txt"
    printf '%s\n' "$REALE" | sed 's/^/      /' >&2
    GUIDE_HITS=$((GUIDE_HITS + 1))
  else
    ok "$(basename "$guide"): nessun comando usa /tmp/ck.txt"
    pass=$((pass + 1))
  fi

  # E la contromisura deve essere DOCUMENTATA: se sparisce dalla guida, chi legge non sa
  # che esiste, e la prossima persona reinventa lo stesso errore.
  if grep -q 'anterislab-env\.sh' "$guide" 2>/dev/null; then
    ok "$(basename "$guide"): documenta scripts/anterislab-env.sh"
    pass=$((pass + 1))
  else
    bad "$(basename "$guide"): non menziona scripts/anterislab-env.sh — la contromisura non e' documentata"
    GUIDE_HITS=$((GUIDE_HITS + 1))
  fi
done
if [ "$GUIDE_SEEN" -eq 0 ]; then
  printf '      (nessuna guida trovata accanto al kit: controllo saltato, non fallito)\n'
fi

# ---------------------------------------------------------------------------
info '4. Ciclo completo contro il server, se e disponibile'
# ---------------------------------------------------------------------------
PORT="${ANTERISLAB_PORT:-8787}"
BASE="http://127.0.0.1:$PORT"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/v1/killswitch/health" 2>/dev/null || printf '000')"

if [ "$CODE" = '200' ]; then
  CS="$WORK/cookie.txt"
  PASSWORD='anterislab-dev'
  LOGIN="$(curl -s -c "$CS" -X POST "$BASE/api/v1/dashboard/login" \
    -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}" 2>/dev/null)"
  if printf '%s' "$LOGIN" | grep -q '"ok":true'; then
    ok 'login accettato'
    pass=$((pass + 1))
  else
    bad "login non riuscito: $LOGIN"
    fail=$((fail + 1))
  fi

  if [ -s "$CS" ] && grep -q 'anterislab_sess' "$CS"; then
    ok 'cookie di sessione scritto e presente nel file'
    pass=$((pass + 1))
    SUM="$(curl -s -b "$CS" "$BASE/api/v1/dashboard/summary?tenant=demo-tenant")"
    if printf '%s' "$SUM" | grep -q 'unauthenticated'; then
      bad 'il server rifiuta una sessione appena creata'
      fail=$((fail + 1))
    else
      ok 'la sessione viene accettata dal server'
      pass=$((pass + 1))
    fi
  else
    bad "il file di sessione non e' stato scritto o non contiene il cookie: $CS"
    fail=$((fail + 1))
  fi
else
  printf '      (nessun server su %s: ciclo completo saltato, non fallito)\n' "$BASE"
  printf '      avvialo con: bash scripts/dev.sh\n'
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[1;32mSession storage: %d controlli superati, 0 falliti.\033[0m\n\n' "$pass"
  exit 0
fi
printf '\033[1;31mSession storage: %d superati, %d FALLITI.\033[0m\n\n' "$pass" "$fail"
exit 1
