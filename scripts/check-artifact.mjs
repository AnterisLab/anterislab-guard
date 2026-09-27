
// Artifact == source verification.
//
// Why this exists: the 0.1.1 published on npm was NOT the build of the source (diverging SHA-256,
// the 402 handling was entirely missing). Anyone installing from the registry received code
// different from what had been reviewed. This script builds from scratch, compares, and fails if
// the bytes differ: it is the gate that makes the artifact/source correspondence demonstrable.
//
// Usage: node scripts/check-artifact.mjs      (exits 0 if coherent, 1 otherwise)

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
  console.error(`[check-artifact] FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(join(root, 'dist'))) fail('dist/ missing: run `npm run build` first');

// 1. The three outputs declared in package.json must exist.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.main !== './dist/index.js') fail(`unexpected main: ${manifest.main}`);
if (manifest.types !== './dist/index.d.ts') fail(`unexpected types: ${manifest.types}`);
for (const file of required) {
  if (!existsSync(join(root, file))) fail(`published file missing: ${file}`);
}
if (!manifest.files.includes('LICENSE')) fail('LICENSE is not in the list of published files');

// 2. The build must be reproducible: rebuild in a clean folder and compare the bytes.
const before = Object.fromEntries(required.map((f) => [f, sha256(join(root, f))]));
rmSync(join(root, 'dist'), { recursive: true, force: true });
try {
  execSync('npx tsc --project tsconfig.json', { cwd: root, stdio: 'inherit' });
} catch {
  fail('the rebuild from scratch did not succeed');
}
for (const file of required) {
  const after = sha256(join(root, file));
  if (after !== before[file]) {
    fail(`artifact != source for ${file}: ${before[file].slice(0, 12)} != ${after.slice(0, 12)}`);
  }
}

// 3. The published code must contain the quota logic (the C-01 defect of 0.1.1) and the positive
//    allow-list of verdicts.
//
//    NOTE (learned the hard way): the first version read only the FIRST file and looked for
//    `GUARD_QUOTA_EXCEEDED` inside it. But `tsc` emits one file per module: strings and symbols
//    live in the file of the module that defines them (`errors.js`, `verdict.js`), not necessarily
//    in `index.js`. The gate failed on a correct package -- a false alarm that, in CI, would have
//    blocked every release. A content check must run on the ENTIRE set of published files, not on
//    a representative file chosen at random.
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
  fail('dist/ does not contain the 402 handling (GuardQuotaError): stale or partial artifact');
}
if (!bundle.includes('AUTHORIZING_VERDICTS')) {
  fail('dist/ does not contain the positive allow-list of verdicts (AUTHORIZING_VERDICTS): fail-open hunt');
}
if (!bundle.includes('GUARD_BLOCKED')) {
  fail('dist/ does not contain the denial for unrecognized response bodies');
}

console.log('[check-artifact] OK: artifact coherent with source, quota and allow-list present');
for (const [file, hash] of Object.entries(before)) {
  console.log(`  ${hash.slice(0, 16)}  ${file}`);
}
