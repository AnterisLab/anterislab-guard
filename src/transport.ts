/**
 * Trasporto HTTP verso /api/v1/evaluate.
 *
 * Vincoli non negoziabili, che sono anche il motivo per cui questo file esiste separato:
 *  - il timeout copre l'INTERA transazione, lettura del corpo inclusa (un endpoint che risponde
 *    con gli header e poi tace non deve bloccare l'agente per sempre);
 *  - i retry coprono solo guasti di trasporto e 5xx. Mai 401/402/403/409;
 *  - su 429 si attende il `Retry-After` DICHIARATO, per intero, oppure si rifiuta: non si ignora;
 *  - la chiave API non compare mai in URL, in corpo o in un messaggio di errore;
 *  - l'`Idempotency-Key` viene generata una volta e riusata su ogni tentativo, cosi' un retry non
 *    consuma due volte la quota del piano.
 */

import { GuardAuthError, GuardPolicyError, GuardQuotaError, GuardUnavailableError } from './errors.js';

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries: number;
  maxRetryAfterMs: number;
  idempotency: boolean;
  sdkVersion: string;
  fetchImpl?: typeof fetch;
}

export interface TransportResponse {
  status: number;
  body: unknown;
  headers: Headers;
  /** Byte esatti del corpo: servono alla verifica della firma HMAC. */
  rawBody: string;
}

/** Un errore HTTP terminale: mappato su una classe della gerarchia GuardError. */
export function mapHttpError(status: number, body: unknown): Error {
  const record = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message : `HTTP ${status}`;

  switch (status) {
    case 401:
      return new GuardAuthError(401, 'chiave API assente, non valida o revocata');
    case 402:
      return new GuardQuotaError(
        typeof record.plan === 'string' ? record.plan : null,
        typeof record.limit === 'number' ? record.limit : null,
        typeof record.used === 'number' ? record.used : null,
      );
    case 403:
      return new GuardAuthError(403, String(record.code ?? 'agent_not_in_scope'));
    case 409:
      return new GuardPolicyError(
        message,
        typeof record.expected === 'string' ? record.expected : null,
        typeof record.received === 'string' ? record.received : null,
      );
    default:
      return new GuardUnavailableError(`il guard ha risposto HTTP ${status}: ${message}`);
  }
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Transport {
  private readonly options: TransportOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TransportOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Esegue una valutazione. Non interpreta il verdetto: restituisce la risposta grezza.
   * Un esito non-200 che sia un errore HTTP terminale viene sollevato qui.
   */
  async evaluate(
    payload: { agent: string; action: Record<string, unknown>; context?: Record<string, unknown> },
    idempotencyKey: string | null,
  ): Promise<TransportResponse> {
    const endpoint = `${this.options.baseUrl}/api/v1/evaluate`;
    const body = JSON.stringify(payload);
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
        'x-anterislab-sdk': this.options.sdkVersion,
        'user-agent': `@anterislab/guard/${this.options.sdkVersion}`,
      };
      if (this.options.idempotency && idempotencyKey) headers['idempotency-key'] = idempotencyKey;

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.options.timeoutMs);

      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        // Il timeout deve coprire anche la lettura del corpo: `fetch` risolve appena arrivano
        // gli header, quindi una lettura lenta sarebbe altrimenti illimitata. E non basta
        // `AbortController`: una `fetch` malata (o un polyfill che ignora il signal) bloccherebbe
        // l'agente per sempre. La scadenza viene quindi imposta QUI, sul tempo di attesa.
        let rawBody: string;
        try {
          rawBody = await this.withDeadline(response.text(), () => {
            timedOut = true;
            controller.abort();
          });
        } finally {
          clearTimeout(timer);
        }

        if (rawBody.length > 262_144) {
          throw new GuardUnavailableError('la risposta del guard supera i 256 KiB: rifiutata');
        }

        let parsed: unknown = null;
        if (rawBody.trim().length > 0) {
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            // Un corpo non-JSON (captive portal, pagina di errore del proxy) e' un guasto,
            // non un permesso. Diventa una risposta 200 non interpretabile -> diniego a valle.
            parsed = null;
          }
        }
        this.assertNoKeyLeak(rawBody);

        if (response.status === 429) {
          const waitMs = parseRetryAfter(response.headers);
          if (waitMs === null) throw new GuardUnavailableError('rate limit senza Retry-After: non si presume nulla');
          if (waitMs > this.options.maxRetryAfterMs || attempt > this.options.retries) {
            throw new GuardUnavailableError(
              `rate limit con attesa richiesta di ${Math.round(waitMs / 1000)} s, oltre il budget consentito`,
            );
          }
          await sleep(waitMs + Math.floor(Math.random() * 250));
          continue;
        }

        if (response.status >= 500) {
          if (attempt > this.options.retries) {
            throw new GuardUnavailableError(`il guard e' indisponibile (HTTP ${response.status})`);
          }
          await sleep(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
          continue;
        }

        if (response.status >= 400) throw mapHttpError(response.status, parsed);

        return { status: response.status, body: parsed, headers: response.headers, rawBody };
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof Error && error.name.startsWith('Guard')) throw error;
        if (timedOut) throw new GuardUnavailableError(`timeout (${this.options.timeoutMs} ms) verso ${this.options.baseUrl}`);
        if (attempt > this.options.retries) {
          throw new GuardUnavailableError(`guasto di rete verso ${this.options.baseUrl}: ${(error as Error).message}`);
        }
        await sleep(200 * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Impone una scadenza a una promessa qualunque. Serve perche' il timeout non puo' dipendere
   * dalla buona volonta' dell'implementazione di `fetch`: se il signal viene ignorato, l'agente
   * deve comunque riprendere il controllo e negare l'azione.
   */
  private async withDeadline<T>(promise: Promise<T>, onTimeout: () => void): Promise<T> {
    void promise.catch(() => undefined); // la perdente della corsa non deve restare "unhandled"
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(
              new GuardUnavailableError(
                `timeout (${this.options.timeoutMs} ms) durante la lettura del corpo della risposta`,
              ),
            );
          }, this.options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Difesa in profondita': la chiave non deve mai finire in un corpo di risposta o di errore. */
  private assertNoKeyLeak(rawBody: string): void {
    if (this.options.apiKey.length >= 16 && rawBody.includes(this.options.apiKey)) {
      throw new GuardUnavailableError('la risposta del guard conteneva la chiave API: rifiutata');
    }
  }
}
