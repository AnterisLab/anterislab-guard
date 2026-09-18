/**
 * Vocabolario dei verdetti.
 *
 * Questa e' l'unica implementazione della decisione "l'azione puo' partire?".
 * La regola e' una allow-list positiva: autorizzano SOLO `APPROVED` e `FLAGGED`.
 * Tutto il resto - campo assente, parola sconosciuta, corpo non-oggetto, HTML di un captive
 * portal, JSON troncato - e' un DINIEGO. Non e' un caso limite: e' il comportamento di default.
 *
 * Il difetto della 0.1.1 era esattamente qui: il codice leggeva `decision === 'BLOCKED'`, quindi
 * una risposta con `{"verdict":"block"}` (lo schema documentato) non matchava e l'azione
 * partiva. Il fail-open non era un bug di trasporto: era la forma del controllo.
 */

export type CanonicalVerdict = 'APPROVED' | 'FLAGGED' | 'PAUSED' | 'BLOCKED';

/** Verdetto che NON puo' mai arrivare dal server: e' riservato al client. */
export const CLIENT_LOCAL_VERDICT = 'UNAVAILABLE';

/** Gli unici verdetti che autorizzano l'esecuzione. */
export const AUTHORIZING_VERDICTS: readonly CanonicalVerdict[] = ['APPROVED', 'FLAGGED'];

/** Verdetti che sospendono o negano. */
export const BLOCKING_VERDICTS: readonly CanonicalVerdict[] = ['PAUSED', 'BLOCKED'];

/** Vocabolario canonico completo che il backend puo' emettere. */
export const CANONICAL_VERDICTS: readonly CanonicalVerdict[] = ['APPROVED', 'FLAGGED', 'PAUSED', 'BLOCKED'];

/**
 * Alias legacy accettati sul filo. Il backend deve emettere il canonico (`decision`); questi
 * esistono solo perche' i client 0.1.x li accettavano e un rilascio coordinato non e' realistico.
 * Ogni alias e' un valore, mai una sottostringa: nessun `includes()`.
 */
export const VERDICT_ALIASES: Readonly<Record<string, CanonicalVerdict>> = Object.freeze({
  approve: 'APPROVED',
  approved: 'APPROVED',
  allow: 'APPROVED',
  allowed: 'APPROVED',
  flag: 'FLAGGED',
  flagged: 'FLAGGED',
  pause: 'PAUSED',
  paused: 'PAUSED',
  block: 'BLOCKED',
  blocked: 'BLOCKED',
  deny: 'BLOCKED',
  denied: 'BLOCKED',
});

/** Campi su cui il verdetto puo' arrivare. `decision` e' il canonico, `verdict` lo specchio legacy. */
export const PRIMARY_VERDICT_FIELD = 'decision';
export const LEGACY_VERDICT_FIELD = 'verdict';

export interface ParsedDecision {
  /** Sempre canonico, sempre uno dei quattro. */
  decision: CanonicalVerdict;
  reason: string;
  policy: string | null;
  decisionId: string | null;
  latencyMs: number | null;
  /** Identita' che il backend dichiara di aver valutato. */
  agent: string | null;
}

export interface VerdictRejection {
  ok: false;
  /** Codice stabile, per log e metriche. */
  code: string;
  detail: string;
}

export type VerdictOutcome = { ok: true; decision: ParsedDecision } | VerdictRejection;

/**
 * Normalizza un valore grezzo a un verdetto canonico. `null` significa "non riconosciuto",
 * che per il chiamante e' un diniego.
 */
export function canonicalizeVerdict(value: unknown): CanonicalVerdict | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 32) return null;
  const upper = normalized.toUpperCase();
  if ((CANONICAL_VERDICTS as readonly string[]).includes(upper)) return upper as CanonicalVerdict;
  return VERDICT_ALIASES[normalized.toLowerCase()] ?? null;
}

/** true quando il verdetto autorizza l'esecuzione. */
export function isAuthorizing(verdict: CanonicalVerdict): boolean {
  return AUTHORIZING_VERDICTS.includes(verdict);
}

function optionalString(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Interpreta il corpo di una risposta /evaluate.
 *
 * Ordine dei controlli, deliberato:
 *  1. il corpo deve essere un oggetto JSON (non array, non null, non HTML, non troncato);
 *  2. entrambi i campi verdetto vengono normalizzati;
 *  3. se entrambi sono presenti e canonicalizzano a valori DIVERSI -> diniego (mai scegliere il
 *     piu' permissivo);
 *  4. se nessuno dei due e' riconosciuto -> diniego;
 *  5. `UNAVAILABLE` dal server -> diniego (il server non deve mai emetterlo);
 *  6. il resto e' deterministico: il verdetto canonicalizzato decide.
 */
export function parseVerdict(body: unknown, expectedAgent?: string | null): VerdictOutcome {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      code: 'verdict_body_not_object',
      detail: `il corpo della risposta non e' un oggetto JSON (ricevuto: ${Array.isArray(body) ? 'array' : body === null ? 'null' : typeof body})`,
    };
  }

  const record = body as Record<string, unknown>;
  const primary = canonicalizeVerdict(record[PRIMARY_VERDICT_FIELD]);
  const legacy = canonicalizeVerdict(record[LEGACY_VERDICT_FIELD]);
  const primaryRaw = record[PRIMARY_VERDICT_FIELD];
  const legacyRaw = record[LEGACY_VERDICT_FIELD];

  // Un campo presente ma non riconosciuto e' un diniego esplicito, non un "assente".
  if (primaryRaw !== undefined && primary === null) {
    return { ok: false, code: 'verdict_unknown_word', detail: `campo "decision" non riconosciuto: ${JSON.stringify(primaryRaw).slice(0, 64)}` };
  }
  if (legacyRaw !== undefined && legacy === null) {
    return { ok: false, code: 'verdict_unknown_word', detail: `campo "verdict" non riconosciuto: ${JSON.stringify(legacyRaw).slice(0, 64)}` };
  }

  if (primary !== null && legacy !== null && primary !== legacy) {
    return {
      ok: false,
      code: 'verdict_conflict',
      detail: `"decision" (${primary}) e "verdict" (${legacy}) si contraddicono: nessuna delle due viene applicata`,
    };
  }

  const decision = primary ?? legacy;
  if (decision === null) {
    return {
      ok: false,
      code: 'verdict_missing',
      detail: 'la risposta non contiene alcun campo verdetto riconoscibile (atteso "decision")',
    };
  }

  if ((decision as string) === CLIENT_LOCAL_VERDICT) {
    return {
      ok: false,
      code: 'verdict_server_emitted_local',
      detail: `${CLIENT_LOCAL_VERDICT} e' riservato al client: un server che lo emette non ha valutato nulla`,
    };
  }

  const agent = optionalString(record.agent, 128);
  if (expectedAgent && agent !== null && agent !== expectedAgent) {
    return {
      ok: false,
      code: 'verdict_agent_mismatch',
      detail: `il verdetto riguarda l'agente "${agent}" ma questo client e' "${expectedAgent}"`,
    };
  }

  const latency = record.latency_ms;
  return {
    ok: true,
    decision: {
      decision,
      reason: optionalString(record.reason, 256) ?? 'nessun motivo fornito',
      policy: optionalString(record.policy, 128),
      decisionId: optionalString(record.decision_id, 128),
      latencyMs: typeof latency === 'number' && Number.isFinite(latency) ? latency : null,
      agent,
    },
  };
}
