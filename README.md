# @anterislab/guard

Real-time policy guard for autonomous agents. One line to wrap your agent — every action is evaluated against your plain-language policies **before** it executes.

```js
import { Guard } from '@anterislab/guard';

const guard = new Guard({ apiKey: process.env.ANTERISLAB_API_KEY });
const safe = guard.wrap(agent, { agent: 'billing-bot', toAction: (a) => a });

await safe.execute({ type: 'payment', amount: 4200, currency: 'EUR' });
// → GuardBlockedError: action BLOCKED by policy "Payment limit"
```

## Install

npm install @anterislab/guard

## Decisions

| Decision | Behavior |
|---|---|
| APPROVED | action proceeds |
| FLAGGED | action proceeds + onDecision hook |
| PAUSED | onPaused hook, or throws GuardPausedError |
| BLOCKED | throws GuardBlockedError — action never runs |

## Options

apiKey (required) · baseUrl · timeoutMs (5000) · retries (1) · failOpen (false) · onDecision · onPaused

Fail-open: with failOpen: true, actions proceed if the guard is unreachable (your choice, as promised in our FAQ). Default is fail closed.

## Frameworks

Works with any tool-calling pattern: LangChain, LangGraph, CrewAI, Autogen or custom orchestration — wrap the function that performs the side effect.

## License

MIT · [anterislab.com](https://www.anterislab.com)
