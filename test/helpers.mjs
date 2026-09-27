/**
 * Test scaffolding. Re-exports and thin wrappers around the public mock
 * (`@anterislab/guard/mock`), plus project-specific helpers.
 *
 * Using the public mock here is deliberate dogfooding: if the public mock is
 * not good enough for our own tests, it is not good enough for consumers.
 */

import { createMockFetch, approvedVerdict } from '../dist/mock.js';

export { signBody } from '../dist/mock.js';

/**
 * Backward-compatible wrapper around `createMockFetch`, exposing the shape the
 * existing tests expect.
 *
 * @param {Parameters<typeof createMockFetch>[0]} route
 */
export function makeFetch(route) {
  const mock = createMockFetch(route);
  const calls = {
    get evaluate() {
      return mock.evaluateCalls;
    },
    get urls() {
      return mock.calls.map((call) => call.url);
    },
  };
  return { impl: mock.fetch, calls };
}

/** Positive response body, defaulting to the agent used across these tests. */
export function approved(agent = 'billing-bot', extra = {}) {
  return approvedVerdict(agent, extra);
}

/** Instrumented agent: counts the side effects actually produced. */
export function makeAgent() {
  const effects = [];
  const agent = {
    async charge(amount) {
      effects.push(`charge:${amount}`);
      return 'ok';
    },
    async refund(amount) {
      effects.push(`refund:${amount}`);
      return 'ok';
    },
    describe() {
      return 'instrumented agent';
    },
  };
  return { agent, effects };
}
