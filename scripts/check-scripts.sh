#!/usr/bin/env bash
# Controllo di sintassi su TUTTI gli script di shell del kit.
#
# Perche' esiste: la 0.2.0 del kit e' stata consegnata con `setup-termux.sh` e
# `release-sdk.sh` sintatticamente INV ALIDI, e non ce ne siamo accorti perche' nessun
# controllo automatico analizzava gli script di shell. `npm test` non li tocca: i test
# riguardano il codice TypeScript, non gli script che servono ad avviarlo.
#
# L'errore che ne derivava era particolarmente insidioso:
#   scripts/setup-termux.sh: line 28: syntax error near unexpected token `('
# indicava la riga 28, ma la causa vera era alla riga 17: un apostrofo "escapato"
# con la barra rovesciata dentro apici singoli.
#
#   fail 'Questo script e\' pensato per Termux.'
#                       ^^ la barra rovesciata NON e' un escape in bash
#
# Bash chiude la stringa al primo apice singolo. Tutto il resto della riga diventa
# codice, e ogni riga successiva viene interpretata a partire da uno stato di
# quotatura sbagliato: l'errore viene segnalato molto piu' in basso di dove e' nato.
#
# Uso:
#   bash scripts/check-scripts.sh
#
# Esce con codice 1 se anche un solo script non passa.

set -euo pipefail

cd "$(dirname "$0")/.."

fail() { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; exit 1; }
ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$1"; }

# bash e' obbligatorio: gli script dichiarano `#!/usr/bin/env bash` o il path di Termux.
command -v bash >/dev/null 2>&1 || fail 'bash non trovato nel PATH'

mapfile -t scripts < <(find . -name '*.sh' -not -path './node_modules/*' \
  -not -path '*/node_modules/*' | sort)

[ "${#scripts[@]}" -gt 0 ] || fail 'nessuno script .sh trovato: sei nella cartella giusta?'

printf 'Controllo di sintassi su %d script\n\n' "${#scripts[@]}"

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

[ "$failed" -eq 0 ] || fail "$failed script su ${#scripts[@]} non passano il controllo di sintassi"

# Ricerca della causa tipica, anche quando la sintassi oggi regge.
# Un apostrofo preceduto da barra rovesciata dentro apici singoli e' SEMPRE un errore,
# anche se per caso il file compila: il messaggio all'utente conterra' una barra rovesciata
# di troppo e il comportamento cambia appena si aggiunge una riga sopra o sotto.
printf '\nRicerca della causa tipica (barra rovesciata prima di apostrofo)...\n'
# I commenti sono esclusi di proposito: questo file stesso contiene la riga sbagliata
# come esempio da non imitare, ed e' l'unico posto dove e' legittima.
if grep -rnF "\\'" --include='*.sh' . 2>/dev/null | grep -v node_modules \
   | grep -vE ':[0-9]+:[[:space:]]*#'; then
  fail 'trovato un apostrofo escapato con barra rovesciata: in bash non e un escape. Usa apici doppi, oppure togli l apostrofo.'
fi
ok 'nessun apostrofo escapato con barra rovesciata'

printf '\n\033[1;32mTutti gli script passano il controllo di sintassi.\033[0m\n'
