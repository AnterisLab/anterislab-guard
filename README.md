# @anterislab/guard

Guardia runtime per agenti autonomi: ogni azione viene valutata **prima** di essere eseguita, e un
ordine di fermarsi ferma davvero l'agente.

Zero dipendenze runtime. Node 18+.

## Installazione

```bash
npm install @anterislab/guard
```

## Uso minimo

```js
import { Guard, GuardBlockedError } from '@anterislab/guard';

const guard = new Guard({ apiKey: process.env.ANTERISLAB_API_KEY });

const charge = guard.wrapFn(paymentAgent.charge, {
  agent: 'billing-bot',
  toAction: (amount) => ({ type: 'payment', amount, currency: 'EUR' }),
});

try {
  await charge(4200);        // se il gate nega, charge() NON viene invocata
} catch (error) {
  if (error instanceof GuardBlockedError) {
    console.error('azione negata:', error.message);
  }
}
```

## Copertura completa: `wrap()`

`wrap()` protegge **ogni** metodo dell'oggetto. Le eccezioni si dichiarano una per una:

```js
const safe = guard.wrap(agent, { agent: 'billing-bot', passthrough: ['describe'] });
await safe.charge(10);     // valutato
await safe.refund(10);     // valutato
safe.describe();           // passante, dichiarato esplicitamente
```

## Kill switch

```js
const guard = new Guard({
  apiKey: process.env.ANTERISLAB_API_KEY,
  killSwitch: { tenant: 'acme', agent: 'billing-bot', baseUrl, apiKey },
});

await guard.halt('incidente in corso', 'INC-1234');   // ferma ORA, senza round-trip
await guard.status();
await guard.resume({ reason: 'fine incidente', evidence: 'INC-1234' });

const stop = await guard.startStream();   // halt via SSE in pochi millisecondi
```

Con `maxStaleSeconds: 0` il client rivalida lo stato a ogni azione; con il default (90 s) riduce i
round-trip e fa affidamento sul controllo lato server come secondo strato.

## Verdetti firmati

```js
new Guard({ apiKey, verifyVerdict: process.env.ANTERISLAB_VERDICT_SECRET });
```

Con `verifyVerdict` configurato, un verdetto positivo **non firmato** viene rifiutato. La firma copre
il corpo esatto della risposta.

## Opzioni

| Opzione | Default | Descrizione |
|---|---|---|
| `apiKey` | — | **Obbligatoria.** Non compare mai in URL, corpo o messaggi d'errore. |
| `baseUrl` | `https://www.anterislab.com` | Origine del control plane. Deve essere in `allowedHosts`. |
| `allowedHosts` | `anterislab.com`, `www.anterislab.com` | Host verso cui la chiave puo' viaggiare. |
| `allowInsecureHttp` | `false` | Consente `http://` **solo** su loopback, per lo sviluppo. |
| `timeoutMs` | `5000` | Copre l'intera transazione, lettura del corpo inclusa. |
| `retries` | `1` | Solo su guasti di trasporto e 5xx. Mai su 401/402/403/409. |
| `maxRetryAfterMs` | `30000` | Attesa massima onorata da un `Retry-After`. Oltre: rifiuto. |
| `failOpen` | `false` | Su guard irraggiungibile prosegue registrando `UNAVAILABLE`. **Non solleva mai un `APPROVED` reale e non aggira un 402.** |
| `verifyVerdict` | — | Segreto HMAC o tuo verificatore `(body, signature) => boolean`. |
| `idempotency` | `true` | `Idempotency-Key` per azione, riusata su ogni retry. |
| `expectedAgent` | — | Vincola il client a una sola identita' agente. |
| `onDecision` | — | Telemetria su ogni verdetto. Non puo' cambiare l'esito. |
| `onPaused` | — | **Notifica.** Se risolve, rigetta o solleva, l'azione non parte. |

## Errori

| Classe | `code` | Cosa fare |
|---|---|---|
| `GuardBlockedError` | `GUARD_BLOCKED` | La policy ha negato. Non ritentare: e' una decisione. |
| `GuardPausedError` | `GUARD_PAUSED` | Serve una revisione umana. Notifica e fermati. |
| `GuardHaltedError` | `GUARD_HALTED` | Kill switch attivo. Attendi il resume. |
| `GuardQuotaError` | `GUARD_QUOTA` | Quota esaurita (`402`). **Terminale.** Alza il piano. |
| `GuardAuthError` | `GUARD_AUTH` | `401`/`403`. Credenziale o perimetro. |
| `GuardPolicyError` | `GUARD_POLICY` | `409`, es. `expected_epoch` non corrispondente. |
| `GuardUnavailableError` | `GUARD_UNAVAILABLE` | Guard irraggiungibile. Fail-closed. |
| `GuardConfigError` | `GUARD_CONFIG` | Configurazione che indebolirebbe le garanzie. |
| `GuardStateInvalidError` | `GUARD_STATE_INVALID` | Stato del kill switch troppo vecchio. |

## Garanzie

1. Un verdetto non riconosciuto **non autorizza** (allow-list positiva, fail-closed).
2. `wrap()` copre ogni metodo: l'errore per omissione e' chiuso.
3. `PAUSED` blocca qualunque cosa faccia l'hook.
4. Il timeout copre anche la lettura del corpo e non dipende dal `signal` di `fetch`.
5. `402`, `401`, `403`, `409` sono terminali: mai ritentati.
6. La chiave API non compare in URL, corpo o log.
7. Un halt arrivato durante la valutazione ferma comunque l'azione (anti-TOCTOU).

## Licenza

MIT
