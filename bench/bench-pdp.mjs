// Bench warm-path PDP decision - AnterisLab Guard
// Misura solo valutazione deterministica (no LLM, no rete, no PSP)
// Uso: node bench-pdp.js
// Output atteso: p95 < 15ms per claim Product Hunt

function pdpDecide(input, policy) {
  // canonical strict checks come da ADR-001: schema, allowlist, velocity
  if (typeof input.amount_minor !== 'number' || input.amount_minor <= 0) return { decision: 'deny', reason: 'bad_amount' };
  if (!policy.allowedMerchants.has(input.merchant)) return { decision: 'deny', reason: 'not_allowlisted' };
  if (input.amount_minor > policy.max_auto) return { decision: 'deny', reason: 'needs_approval' };
  const spent = policy.velocityWindow.get(input.tenant) || 0;
  if (spent + input.amount_minor > policy.velocityCap) return { decision: 'deny', reason: 'velocity_exceeded' };
  return { decision: 'permit' };
}

const policy = {
  allowedMerchants: new Set(['stripe-test-merchant', 'acme-store']),
  max_auto: 5000, // 50.00 EUR in cent
  velocityCap: 20000,
  velocityWindow: new Map([['tenant_demo', 1200]]),
};

const input = { amount_minor: 1999, currency: 'EUR', merchant: 'acme-store', tenant: 'tenant_demo' };

// warmup
for (let i = 0; i < 100; i++) pdpDecide(input, policy);

const N = 2000;
const times = [];
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  pdpDecide(input, policy);
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6); // ms
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.floor((p / 100) * N)];
const avg = times.reduce((a, b) => a + b, 0) / N;

console.log(JSON.stringify({
  n: N,
  avg_ms: Number(avg.toFixed(4)),
  p50_ms: Number(pct(50).toFixed(4)),
  p95_ms: Number(pct(95).toFixed(4)),
  p99_ms: Number(pct(99).toFixed(4)),
  max_ms: Number(times[N-1].toFixed(4)),
  pass_15ms: pct(95) < 15,
  method: 'warm-path PDP only, no LLM, no network, no PSP',
}, null, 2));

if (pct(95) >= 15) { console.error('FAIL: p95 >= 15ms'); process.exit(1); }
else console.log('PASS: warm-path p95 < 15ms');
