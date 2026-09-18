/**
 * Descrittore dell'azione inviata a /api/v1/evaluate.
 *
 * Deriva dal `types.d.ts` pubblicato della 0.1.2: e' la forma REALE, non quella che sarebbe
 * piaciuta. Durante la stesura del contratto v17 e' emerso proprio questo: il descrittore e'
 * { type, target, domain, amount, currency, recipients, query, direction, external, metadata }
 * e non { name, resource, params }. Uno schema si ricava dall'artefatto, non dall'intenzione.
 */
export interface GuardAction {
  /** Tipo dell'azione, es. `payment`, `email.send`, `db.delete`. Obbligatorio. */
  type: string;
  /** Bersaglio dell'azione (risorsa, tabella, endpoint). */
  target?: string;
  /** Dominio di rete, se l'azione esce verso Internet. */
  domain?: string;
  /** Importo, per le azioni finanziarie. */
  amount?: number;
  /** Valuta ISO-4217, es. `EUR`. */
  currency?: string;
  /** Numero di destinatari, per invii massivi. */
  recipients?: number;
  /** Query, per letture dati. */
  query?: string;
  /** Direzione del flusso, per movimenti di denaro o dati. */
  direction?: 'inbound' | 'outbound';
  /** true quando l'azione supera il confine del tenant. */
  external?: boolean;
  /**
   * Metadati non sensibili. ATTENZIONE: non metterci PII o segreti. Il SDK allega la propria
   * `args_digest`; gli argomenti grezzi non vengono mai serializzati nel payload.
   */
  metadata?: Record<string, unknown>;
}
