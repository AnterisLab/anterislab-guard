// Verifica artefatto == sorgente.
//
// Perche' esiste: la 0.1.1 pubblicata su npm NON era la build del sorgente (SHA-256 divergenti,
// mancava del tutto la gestione del 402). Chi installava dal registro riceveva un codice diverso
// da quello revisionato. Questo script costruisce da zero, confronta e fallisce se i byte
// differiscono: e' il cancello che rende dimostrabile la corrispondenza artefatto/sorgente.
//
// Uso: node scripts/check-artifact.mjs      (esce 0 se coerente, 1 altrimenti)

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const required = ['dist/index.js', 'dist/index.d.ts', 'package.json'];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fail(message) {
  console.error(`[check-artifact] FALLITO: ${message}`);
  process.exit(1);
}

if (!existsSync(join(root, 'dist'))) fail('dist/ assente: esegui prima `npm run build`');

// 1. Le tre uscite dichiarate in package.json devono esistere.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.main !== './dist/index.js') fail(`main inatteso: ${manifest.main}`);
if (manifest.types !== './dist/index.d.ts') fail(`types inattesi: ${manifest.types}`);
for (const file of required) {
  if (!existsSync(join(root, file))) fail(`file pubblicato mancante: ${file}`);
}
if (!manifest.files.includes('LICENSE')) fail('LICENSE non e\' nell\'elenco dei file pubblicati');

// 2. Il build deve essere riproducibile: ricostruisci in una cartella pulita e confronta i byte.
const before = Object.fromEntries(required.map((f) => [f, sha256(join(root, f))]));
rmSync(join(root, 'dist'), { recursive: true, force: true });
try {
  execSync('npx tsc --project tsconfig.json', { cwd: root, stdio: 'inherit' });
} catch {
  fail('la ricostruzione da zero non e\' riuscita');
}
for (const file of required) {
  const after = sha256(join(root, file));
  if (after !== before[file]) {
    fail(`artefatto != sorgente per ${file}: ${before[file].slice(0, 12)} != ${after.slice(0, 12)}`);
  }
}

// 3. Il codice pubblicato deve contenere la logica di quota (il difetto C-01 della 0.1.1) e
//    l'allow-list positiva dei verdetti.
//
//    NOTA (imparata sulla mia pelle): la prima versione leggeva solo il PRIMO file e cercava
//    `GUARD_QUOTA_EXCEEDED` li' dentro. Ma `tsc` emette un file per modulo: stringhe e simboli si
//    trovano nel file del modulo che li definisce (`errors.js`, `verdict.js`), non necessariamente
//    in `index.js`. Il cancello falliva su un pacchetto corretto — un falso allarme che, in CI,
//    avrebbe bloccato ogni release. Un controllo di contenuto va fatto su TUTTO l'insieme dei file
//    pubblicati, non su un file rappresentativo scelto a caso.
const published = required
  .filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'))
  .map((file) => readFileSync(join(root, file), 'utf8'))
  .join('\n');

// Le stringhe possono vivere in qualunque modulo emesso: si legge l'intera cartella dist.
function readDistBundle() {
  const parts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(join(root, 'dist'));
  return parts.join('\n');
}

const bundle = readDistBundle();
if (!bundle.includes('GUARD_QUOTA_EXCEEDED')) {
  fail('dist/ non contiene la gestione del 402 (GuardQuotaError): artefatto vecchio o parziale');
}
if (!bundle.includes('AUTHORIZING_VERDICTS')) {
  fail('dist/ non contiene l\'allow-list positiva dei verdetti (AUTHORIZING_VERDICTS): ricerca del fail-open');
}
if (!bundle.includes('GUARD_BLOCKED')) {
  fail('dist/ non contiene il diniego per corpi di risposta non riconosciuti');
}

console.log('[check-artifact] OK: artefatto coerente con il sorgente, quota e allow-list presenti');
for (const [file, hash] of Object.entries(before)) {
  console.log(`  ${hash.slice(0, 16)}  ${file}`);
}
