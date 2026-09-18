#!/usr/bin/env bash
# Dice DOVE SEI, DOVE DEVI ESSERE, e cosa fare per tornarci.
#
# Perche' esiste (difetto K13):
#   La sezione 6.2 della guida conteneva
#       cd ../server && npm install && npm run build
#   che lascia il terminale DENTRO la cartella server/. La sezione 7.3 dice poi
#       source scripts/anterislab-env.sh
#   e da dentro server/ quel percorso NON esiste: c'e' un scripts/, ma e' quello
#   del control plane (contiene solo verify-guarantees.mjs).
#
#   Il messaggio che ne esce e' questo, ed e' IDENTICO a quello di un file mancante:
#       bash: scripts/anterislab-env.sh: No such file or directory
#
#   Il file esiste, il kit e' completo e i permessi sono giusti: sei solo un livello
#   sotto. Questo script lo dice in una riga, invece di lasciarlo dedurre.
#
# Uso, da QUALUNQUE cartella:
#     bash scripts/check-position.sh
# oppure, se sei perso e non trovi nemmeno lo script:
#     bash "$(find ~ -maxdepth 4 -name check-position.sh 2>/dev/null | head -n1)"

set -uo pipefail

ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$1"; }
bad()  { printf '\033[1;31m[x]\033[0m %s\n' "$1" >&2; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$1"; }
info() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }

# --- 1. Qual e' la radice del kit? -----------------------------------------
# Una cartella e' la radice se contiene guard/ E server/ E scripts/dev.sh.
# Non ci si basa sul nome della cartella: chi la rinomina in "anterislab" o "stack"
# non deve rompere nulla.
is_root() {
  [ -d "$1/guard" ] && [ -d "$1/server" ] && [ -f "$1/scripts/dev.sh" ]
}

# Risali dal percorso dello script (funziona anche se lo lanci da altrove).
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SELF_DIR/.." && pwd)"

if ! is_root "$ROOT"; then
  # Caso limite: lo script e' stato copiato fuori dal kit. Cerco la radice intorno.
  ROOT=''
  for c in "$PWD" "$PWD/.." "$PWD/../.." "$SELF_DIR/.." "$HOME"; do
    if is_root "$c"; then ROOT="$(cd "$c" && pwd)"; break; fi
  done
fi

info "Posizione"
printf '    Cartella attuale:  %s\n' "$PWD"
if [ -n "$ROOT" ]; then
  printf '    Radice del kit:    %s\n' "$ROOT"
  if [ "$PWD" = "$ROOT" ]; then
    ok "Sei nella radice del kit: i comandi con scripts/... funzionano."
  else
    warn "Sei FUORI dalla radice del kit."
    printf '    I comandi della guida che iniziano con  scripts/...  NON funzionano da qui.\n'
    printf '    Torna alla radice con:\n\n'
    printf '        cd "%s"\n' "$ROOT"
  fi
else
  bad "Non trovo la radice del kit: serve una cartella con guard/, server/ e scripts/dev.sh."
  printf '    Cercala con:\n'
  printf '        find ~ -maxdepth 4 -name dev.sh -path "*/scripts/*" 2>/dev/null\n'
  exit 1
fi

# --- 2. La cartella in cui sei ha un scripts/ suo? --------------------------
# E' la trappola esatta: server/scripts/ esiste, quindi un semplice ls non fa
# sospettare nulla, ma dentro c'e' tutt'altro.
if [ -d "$PWD/scripts" ] && [ "$PWD" != "$ROOT" ]; then
  printf '\n'
  warn "Questa cartella ha un suo scripts/, ma non e' quello del kit."
  printf '    Contenuto:\n'
  ls -1 "$PWD/scripts" 2>/dev/null | sed 's/^/        /'
  printf '    Gli script della guida stanno invece in:  %s/scripts\n' "$ROOT"
fi

# --- 3. Ci sono tutti gli script attesi? ------------------------------------
info "File del kit"
MISSING=0
for f in scripts/anterislab-env.sh scripts/doctor.sh scripts/dashboard-check.sh \
         scripts/check-position.sh scripts/dev.sh scripts/check-scripts.sh; do
  if [ -f "$ROOT/$f" ]; then
    ok "$f"
  else
    bad "$f  MANCANTE"
    MISSING=$((MISSING+1))
  fi
done

if [ "$MISSING" -gt 0 ]; then
  printf '\n'
  bad "Mancano $MISSING file: stai usando un kit VECCHIO."
  printf '    Il kit con gli script di diagnosi e la versione 2.2 o successiva.\n'
  printf '    Scarica il kit aggiornato dalla guida, oppure verifica di aver estratto tutto lo zip.\n'
  exit 1
fi

# --- 4. Permessi di esecuzione ----------------------------------------------
# Il difetto K14: i quattro script aggiunti in 2.2 sono finiti nello zip con modo 644,
# mentre gli originali erano 755. "bash script.sh" funziona lo stesso, ma "./script.sh"
# da' "Permission denied" e sembra un problema di sistema. Meglio dirlo qui.
info "Permessi"
NOEXEC=0
for f in "$ROOT"/scripts/*.sh; do
  [ -f "$f" ] || continue
  if [ ! -x "$f" ]; then
    NOEXEC=$((NOEXEC+1))
    printf '    %s  (modo %s)\n' "$(basename "$f")" "$(stat -c '%a' "$f" 2>/dev/null || echo '?')"
  fi
done
if [ "$NOEXEC" -eq 0 ]; then
  ok "Tutti gli script sono eseguibili."
else
  warn "$NOEXEC script non hanno il permesso di esecuzione."
  printf '    Non e un errore, ma ./script.sh fallira con Permission denied.\n'
  printf '    Due strade, entrambe valide:\n'
  printf '        bash <script>                       (sempre, senza permessi)\n'
  printf '        chmod +x "%s"/scripts/*.sh          (una volta sola)\n' "$ROOT"
fi

# --- 5. Come proseguire -----------------------------------------------------
info "Prossimo comando"
printf '    cd "%s"\n' "$ROOT"
printf '    source scripts/anterislab-env.sh\n'
printf '\n'
printf 'Il comando finale deve stampare tre righe che iniziano con  ==>  .\n'
