/**
 * Descriptor of the action sent to /api/v1/evaluate.
 *
 * Derives from the published `types.d.ts` of 0.1.2: it is the REAL shape, not the one we would
 * have liked. While drafting contract v17 this is exactly what emerged: the descriptor is
 * { type, target, domain, amount, currency, recipients, query, direction, external, metadata }
 * and not { name, resource, params }. A schema is derived from the artifact, not from intent.
 */
export interface GuardAction {
  /** Action type, e.g. `payment`, `email.send`, `db.delete`. Required. */
  type: string;
  /** Action target (resource, table, endpoint). */
  target?: string;
  /** Network domain, if the action goes out to the Internet. */
  domain?: string;
  /** Amount, for financial actions. */
  amount?: number;
  /** ISO-4217 currency, e.g. `EUR`. */
  currency?: string;
  /** Number of recipients, for bulk sends. */
  recipients?: number;
  /** Query, for data reads. */
  query?: string;
  /** Flow direction, for money or data movements. */
  direction?: 'inbound' | 'outbound';
  /** true when the action crosses the tenant boundary. */
  external?: boolean;
  /**
   * Non-sensitive metadata. WARNING: do not put PII or secrets here. The SDK attaches its own
   * `args_digest`; raw arguments are never serialized in the payload.
   */
  metadata?: Record<string, unknown>;
}
