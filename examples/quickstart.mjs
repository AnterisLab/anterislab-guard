// node examples/quickstart.mjs  (dopo npm run build)
import { Guard, GuardBlockedError } from '../dist/index.js';

const guard = new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
  onDecision: (d) => console.log(`[${d.decision}] ${d.reason} (${d.latency_ms}ms)`),
});

// 1) Check manuale
const d = await guard.check('billing-bot', {
  type: 'payment', amount: 4200, currency: 'EUR', target: 'stripe.payments.create',
});
console.log(d);

// 2) Wrap one-line di un agente
const agent = {
  async execute(action) { return `executed: ${action.type}`; },
};
const safe = guard.wrap(agent, { agent: 'billing-bot', toAction: (a) => a });

try {
  console.log(await safe.execute({ type: 'payment', amount: 420, currency: 'EUR' }));   // APPROVED
  console.log(await safe.execute({ type: 'payment', amount: 4200, currency: 'EUR' }));  // BLOCKED → throw
} catch (e) {
  if (e instanceof GuardBlockedError) console.log('🛡️ blocked:', e.message);
  else throw e;
}
