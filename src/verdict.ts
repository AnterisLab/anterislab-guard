/**
 * Verdict vocabulary.
 *
 * This is the single implementation of the decision "may the action proceed?".
 * The rule is a positive allow-list: only `APPROVED` and `FLAGGED` authorize.
 * Everything else - missing field, unknown word, non-object body, HTML from a captive
 * portal, truncated JSON - is a DENIAL. It is not an edge case: it is the default behavior.
 *
 * The 0.1.1 defect was exactly here: the code read `decision === 'BLOCKED'`, so a response
 * with `{"verdict":"block"}` (the documented schema) did not match and the action went
 * through. Fail-open was not a transport bug: it was the shape of the check.
 */

export type CanonicalVerdict = 'APPROVED' | 'FLAGGED' | 'PAUSED' | 'BLOCKED';

/** Verdict that must NEVER arrive from the server: it is reserved for the client. */
export const CLIENT_LOCAL_VERDICT = 'UNAVAILABLE';

/** The only verdicts that authorize execution. */
export const AUTHORIZING_VERDICTS: readonly CanonicalVerdict[] = ['APPROVED', 'FLAGGED'];

/** Verdicts that suspend or deny. */
export const BLOCKING_VERDICTS: readonly CanonicalVerdict[] = ['PAUSED', 'BLOCKED'];

/** Full canonical vocabulary the backend may emit. */
export const CANONICAL_VERDICTS: readonly CanonicalVerdict[] = ['APPROVED', 'FLAGGED', 'PAUSED', 'BLOCKED'];

/**
 * Legacy aliases accepted on the wire. The backend must emit the canonical (`decision`); these
 * exist only because 0.1.x clients accepted them and a coordinated release is not realistic.
 * Every alias is a value, never a substring: no `includes()`.
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

/** Fields the verdict may arrive on. `decision` is canonical, `verdict` is the legacy mirror. */
export const PRIMARY_VERDICT_FIELD = 'decision';
export const LEGACY_VERDICT_FIELD = 'verdict';

export interface ParsedDecision {
  /** Always canonical, always one of the four. */
  decision: CanonicalVerdict;
  reason: string;
  policy: string | null;
  decisionId: string | null;
  latencyMs: number | null;
  /** Identity the backend claims to have evaluated. */
  agent: string | null;
}

export interface VerdictRejection {
  ok: false;
  /** Stable code, for logs and metrics. */
  code: string;
  detail: string;
}

export type VerdictOutcome = { ok: true; decision: ParsedDecision } | VerdictRejection;

/**
 * Normalizes a raw value to a canonical verdict. `null` means "unrecognized",
 * which is a denial for the caller.
 */
export function canonicalizeVerdict(value: unknown): CanonicalVerdict | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 32) return null;
  const upper = normalized.toUpperCase();
  if ((CANONICAL_VERDICTS as readonly string[]).includes(upper)) return upper as CanonicalVerdict;
  return VERDICT_ALIASES[normalized.toLowerCase()] ?? null;
}

/** true when the verdict authorizes execution. */
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
 * Interprets the body of an /evaluate response.
 *
 * Order of checks, deliberate:
 *  1. the body must be a JSON object (not array, not null, not HTML, not truncated);
 *  2. both verdict fields are normalized;
 *  3. if both are present and canonicalize to DIFFERENT values -> denial (never pick the
 *     more permissive one);
 *  4. if neither is recognized -> denial;
 *  5. `UNAVAILABLE` from the server -> denial (the server must never emit it);
 *  6. the rest is deterministic: the canonicalized verdict decides.
 */
export function parseVerdict(body: unknown, expectedAgent?: string | null): VerdictOutcome {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      code: 'verdict_body_not_object',
      detail: `the response body is not a JSON object (received: ${Array.isArray(body) ? 'array' : body === null ? 'null' : typeof body})`,
    };
  }

  const record = body as Record<string, unknown>;
  const primary = canonicalizeVerdict(record[PRIMARY_VERDICT_FIELD]);
  const legacy = canonicalizeVerdict(record[LEGACY_VERDICT_FIELD]);
  const primaryRaw = record[PRIMARY_VERDICT_FIELD];
  const legacyRaw = record[LEGACY_VERDICT_FIELD];

  // A field present but unrecognized is an explicit denial, not an "absent" one.
  if (primaryRaw !== undefined && primary === null) {
    return { ok: false, code: 'verdict_unknown_word', detail: `unrecognized "decision" field: ${JSON.stringify(primaryRaw).slice(0, 64)}` };
  }
  if (legacyRaw !== undefined && legacy === null) {
    return { ok: false, code: 'verdict_unknown_word', detail: `unrecognized "verdict" field: ${JSON.stringify(legacyRaw).slice(0, 64)}` };
  }

  if (primary !== null && legacy !== null && primary !== legacy) {
    return {
      ok: false,
      code: 'verdict_conflict',
      detail: `"decision" (${primary}) and "verdict" (${legacy}) contradict each other: neither is applied`,
    };
  }

  const decision = primary ?? legacy;
  if (decision === null) {
    return {
      ok: false,
      code: 'verdict_missing',
      detail: 'the response does not contain any recognizable verdict field (expected "decision")',
    };
  }

  if ((decision as string) === CLIENT_LOCAL_VERDICT) {
    return {
      ok: false,
      code: 'verdict_server_emitted_local',
      detail: `${CLIENT_LOCAL_VERDICT} is reserved for the client: a server that emits it has evaluated nothing`,
    };
  }

  const agent = optionalString(record.agent, 128);
  if (expectedAgent && agent !== null && agent !== expectedAgent) {
    return {
      ok: false,
      code: 'verdict_agent_mismatch',
      detail: `the verdict concerns agent "${agent}" but this client is "${expectedAgent}"`,
    };
  }

  const latency = record.latency_ms;
  return {
    ok: true,
    decision: {
      decision,
      reason: optionalString(record.reason, 256) ?? 'no reason provided',
      policy: optionalString(record.policy, 128),
      decisionId: optionalString(record.decision_id, 128),
      latencyMs: typeof latency === 'number' && Number.isFinite(latency) ? latency : null,
      agent,
    },
  };
}
