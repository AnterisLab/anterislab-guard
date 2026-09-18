/**
 * AnterisLab Guard — kill-switch client.
 *
 * One object that gives an agent three things:
 *
 *   1. **A local halt that works with no network at all.** `haltLocal()` flips the client to HALTED
 *      synchronously, in-process, and every subsequent guarded action is refused. This is the
 *      capability 0.1.1 did not have: previously, if the service was unreachable, nothing stopped,
 *      and a flood of 429s actively pushed the guard to fail-open.
 *
 *   2. **Verified state, never a trusted transport.** `refresh()` fetches the signed state and
 *      checks the JWS locally against the issuer's public keys. `verifyStatus(token)` exposes the
 *      same check for a token that arrived over some other channel.
 *
 *   3. **Fail-closed by default.** If the state cannot be established — unreachable, timeout, 5xx,
 *      malformed or unsigned body, expired token, epoch rollback — the client treats the scope as
 *      HALTED and refuses the action. Proceeding is available only through the explicit,
 *      deliberately-awkward `allowFailOpen` opt-in.
 *
 * Every activation (control-plane halt, local halt, a refusal, a resume) is appended to a local
 * hash-chained audit trail that the operator can export alongside the server-side chain.
 */

import { canonicalize } from '../shared/canonical-json.js';
import { stripTrailingSlashes } from '../shared/url.js';
import { b64uToBytes, bytesToB64u, utf8Encode } from '../shared/base64url.js';
import {
  KILL_SWITCH_DEFAULT_AUDIENCE,
  type KillSwitchClaims,
  type SignedKillSwitchState,
} from '../shared/killswitch-types.js';
import {
  KillSwitchHaltedError,
  KillSwitchConfigError,
  KillSwitchLocalHaltError,
  KillSwitchRollbackError,
  KillSwitchStaleError,
  KillSwitchUnavailableError,
  type KillSwitchErrorDetails,
} from './errors.js';
import { fetchJwks, KillSwitchKeyStore, verifyKillSwitchToken, type VerifyResult } from './verifier.js';

export interface KillSwitchManagerOptions {
  /** Tenant the client belongs to. Required. */
  tenant: string;
  /** Agent identity this guard protects. Required — scope coverage is checked against it. */
  agent: string;
  /** Control-plane origin, e.g. https://www.anterislab.com. */
  baseUrl: string;
  /** Credential with `killswitch:read` (and `killswitch:report` to report local halts). */
  apiKey: string;
  audience?: string;
  issuers?: readonly string[];
  /** Freshness bound for the verified state. Beyond it the client fails closed. Default 90s. */
  maxStaleSeconds?: number;
  /** How often `refresh()` may hit the network. Default 15s. */
  minRefreshIntervalSeconds?: number;
  /**
   * Fail closed when the state cannot be established. Default `true`, and the only safe value.
   * Setting it to false requires `allowFailOpen: true` and is recorded in the local audit trail.
   */
  failClosed?: boolean;
  /** Explicit acknowledgement required to disable fail-closed behaviour. */
  allowFailOpen?: boolean;
  /** Pre-loaded JWKS (avoids a round trip; also the only option for air-gapped deployments). */
  jwks?: Parameters<typeof KillSwitchKeyStore.fromJwks>[0];
  /** Pin keys directly by kid. Skips JWKS fetching entirely when the URL is not reachable. */
  pinnedKeys?: Record<string, { kty: 'OKP'; crv: 'Ed25519'; x: string } | { kty: 'oct'; k: string }>;
  /** Allowed signature algorithms. Default ['EdDSA']. HS256 must be opted into explicitly. */
  allowedAlgorithms?: readonly string[];
  fetchImpl?: typeof fetch;
  /** Injected clock (unix seconds) for deterministic tests. */
  now?: () => number;
  /** Stream URL for push propagation. When set, `startStream()` keeps state fresh in real time. */
  streamPath?: string;
  /** Invoked on every state change and every refusal — wire it to your own telemetry. */
  onEvent?: (event: KillSwitchClientEvent) => void;
  /** Injectable crypto digest (tests only). Defaults to WebCrypto SHA-256. */
  digestHex?: (input: string) => Promise<string>;
}

export interface KillSwitchClientEvent {
  type: 'state' | 'halted' | 'resumed' | 'refused' | 'error' | 'local_halt' | 'local_resume';
  at: number;
  epoch?: number;
  reason: string;
  origin?: 'control-plane' | 'local';
}

export interface KillSwitchStatus {
  halted: boolean;
  reason: string;
  epoch: number;
  origin: 'control-plane' | 'local';
  /** True when the state came from a cryptographically verified token. */
  verified: boolean;
  tenant: string;
  agent: string;
  /** Unix seconds. */
  at: number;
  /** Unix seconds when the underlying token was fetched, or null for a purely local halt. */
  fetchedAt: number | null;
  token?: string;
}

export interface LocalAuditEntry {
  seq: number;
  at: number;
  action: 'local_halt' | 'local_resume' | 'refused' | 'state_applied' | 'stream_open' | 'fail_open_warning';
  reason: string;
  epoch: number | null;
  verified: boolean;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

export class KillSwitchManager {
  readonly tenant: string;
  readonly agent: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly audience: string;
  private readonly issuers?: readonly string[];
  private readonly maxStaleSeconds: number;
  private readonly minRefreshIntervalSeconds: number;
  private readonly allowFailOpen: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onEvent?: (event: KillSwitchClientEvent) => void;
  private readonly digestHex: (input: string) => Promise<string>;
  private readonly keyStore: KillSwitchKeyStore;
  private readonly streamPath: string;

  /** Highest verified epoch. Monotonic: a lower epoch is a replay and is rejected. */
  private highestEpoch = 0;
  /** Last verified control-plane status, or null when none was ever obtained. */
  private status: KillSwitchStatus | null = null;
  private lastRefreshAttempt = 0;
  private jwksLoaded = false;
  private streamController: AbortController | null = null;
  private localAudit: LocalAuditEntry[] = [];
  private localAuditHead = GENESIS;
  private auditSeq = 0;

  constructor(options: KillSwitchManagerOptions) {
    if (!options?.tenant) throw new KillSwitchConfigError('`tenant` is required');
    if (!options?.agent) throw new KillSwitchConfigError('`agent` is required');
    if (!options?.baseUrl) throw new KillSwitchConfigError('`baseUrl` is required');
    if (!options?.apiKey) throw new KillSwitchConfigError('`apiKey` is required');

    const allowedAlgorithms = options.allowedAlgorithms ?? ['EdDSA'];
    if (allowedAlgorithms.length === 0) {
      throw new KillSwitchConfigError('`allowedAlgorithms` must not be empty');
    }

    const failOpenRequested = options.failClosed === false;
    if (failOpenRequested && options.allowFailOpen !== true) {
      throw new KillSwitchConfigError(
        'failClosed: false requires allowFailOpen: true. Proceeding while the kill-switch state is unknown ' +
          'removes the only guarantee the control plane can make about an agent, so it must be an explicit choice.',
      );
    }
    this.allowFailOpen = failOpenRequested && options.allowFailOpen === true;

    this.tenant = options.tenant;
    this.agent = options.agent;
    this.baseUrl = stripTrailingSlashes(options.baseUrl);
    this.apiKey = options.apiKey;
    this.audience = options.audience ?? KILL_SWITCH_DEFAULT_AUDIENCE;
    if (options.issuers !== undefined) this.issuers = options.issuers;
    this.maxStaleSeconds = options.maxStaleSeconds ?? 90;
    this.minRefreshIntervalSeconds = options.minRefreshIntervalSeconds ?? 15;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    if (options.onEvent !== undefined) this.onEvent = options.onEvent;
    this.digestHex = options.digestHex ?? defaultDigestHex;
    this.streamPath = options.streamPath ?? '/api/v1/killswitch/stream';

    this.keyStore = new KillSwitchKeyStore(allowedAlgorithms);
    if (options.jwks) this.keyStore.loadJwks(options.jwks);
    for (const [kid, key] of Object.entries(options.pinnedKeys ?? {})) {
      this.keyStore.addKey(kid, key.kty === 'OKP' ? { ...key, kid } : { ...key, kid });
    }
    this.jwksLoaded = this.keyStore.size > 0;
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  /** Current belief. `null` means "never established" — which `enforce()` treats as HALTED. */
  get currentStatus(): KillSwitchStatus | null {
    return this.status;
  }

  /** True when actions must be refused right now. Fails closed when nothing is established. */
  get halted(): boolean {
    if (this.localHalted) return true;
    if (!this.status) return true;
    if (this.isStale()) return true;
    return this.status.halted;
  }

  private get localHalted(): boolean {
    return this.status !== null && this.status.origin === 'local' && this.status.halted;
  }

  /** Telemetry hook. A throwing consumer must never influence a security decision. */
  private emit(event: KillSwitchClientEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Deliberately swallowed: telemetry is best-effort, enforcement is not.
    }
  }

  private isStale(): boolean {
    if (!this.status) return true;
    if (this.status.origin === 'local') return false;
    if (this.status.fetchedAt === null) return true;
    return this.now() - this.status.fetchedAt > this.maxStaleSeconds;
  }

  /**
   * Verify a state token. Never throws for a bad token: a failure is a result, and callers decide
   * policy. A ROLLBACK failure additionally raises the local bar, because it is evidence of an
   * attack rather than a fault.
   */
  async verifyStatus(token: string): Promise<VerifyResult> {
    await this.ensureKeys();
    const startedAt = this.now();
    const result = await verifyKillSwitchToken(token, {
      keyStore: this.keyStore,
      audience: this.audience,
      now: startedAt,
      ...(this.issuers ? { issuers: this.issuers } : {}),
      ...(this.highestEpoch > 0 ? { previousEpoch: this.highestEpoch } : {}),
      expectedSubject: this.tenant,
      expectedAgent: this.agent,
    });
    if (result.ok) {
      if (result.claims.epoch > this.highestEpoch) this.highestEpoch = result.claims.epoch;
    } else if (result.code === 'KILL_SWITCH_STATE_ROLLBACK') {
      this.emit({ type: 'error', at: startedAt, reason: result.detail, origin: 'control-plane' });
    }
    return result;
  }

  /**
   * Establish the current state, going to the network when the cache is cold or stale.
   * Resolves with the status to act on — including the fail-closed HALTED status it synthesises
   * when the control plane cannot be reached.
   */
  async refresh(force = false): Promise<KillSwitchStatus> {
    const now = this.now();
    if (!force && this.status && !this.isStale() && now - this.lastRefreshAttempt < this.minRefreshIntervalSeconds) {
      return this.status;
    }
    this.lastRefreshAttempt = now;

    // A local halt is never silently cleared by a refresh: only an explicit resume can clear it,
    // and only on top of a freshly verified control-plane state.
    const previousLocal = this.localHalted ? this.status : null;

    try {
      const state = await this.fetchState();
      const result = await this.verifyStatus(state.token);
      if (!result.ok) {
        return this.failClosedResult(result.code === 'KILL_SWITCH_STATE_STALE' ? 'stale state token' : result.detail, now);
      }
      const claims = result.claims;

      if (previousLocal) {
        // Stay halted: the local halt is the stronger signal until an operator clears it. The
        // observation is still recorded, so an investigation can see that the control plane was
        // reachable and what it said while the client kept itself stopped.
        previousLocal.fetchedAt = now;
        await this.recordLocal(
          'state_applied',
          `local halt still in force (control plane reports ${claims.state} @ epoch ${claims.epoch})`,
          previousLocal.epoch,
          true,
        );
        this.emit({ type: 'state', at: now, epoch: previousLocal.epoch, reason: 'local halt still in force', origin: 'local' });
        return previousLocal;
      }

      const next = statusFromClaims(claims, now, state.token);
      const changed = this.status?.halted !== next.halted || this.status?.epoch !== next.epoch;
      this.status = next;
      if (changed) {
        await this.recordLocal('state_applied', next.reason, next.epoch, true);
        this.emit({
          type: next.halted ? 'halted' : 'resumed',
          at: now,
          epoch: next.epoch,
          reason: next.reason,
          origin: 'control-plane',
        });
      }
      return next;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.failClosedResult(detail, now);
    }
  }

  /**
   * Decide whether the next action may run. This is the single gate every guarded call goes
   * through, and it fails closed.
   */
  async checkStatus(): Promise<KillSwitchStatus> {
    if (this.status && !this.isStale()) return this.status;
    return this.refresh();
  }

  /**
   * Gate an action. Throws `GuardHaltedError` when the switch is engaged (or when the state could
   * not be established and fail-closed is in force) and `KillSwitchStaleError` when the verified
   * state is too old. Returns normally only when it is safe to proceed.
   *
   * `refresh: false` gives a zero-network fast path for callers that already verified a token
   * moments ago and cannot afford a round trip on the hot path — in that mode an aged state is a
   * hard refusal rather than an implicit refresh.
   */
  async enforce(options: { refresh?: boolean } = {}): Promise<KillSwitchStatus> {
    const status = options.refresh === false ? this.requireVerifiedStatus() : await this.checkStatus();
    if (status.halted) {
      await this.recordLocal('refused', status.reason, status.epoch, status.verified);
      this.emit({ type: 'refused', at: status.at, epoch: status.epoch, reason: status.reason, origin: status.origin });
      throw new KillSwitchHaltedError({
        reason: status.reason,
        epoch: status.epoch,
        origin: status.origin,
        verified: status.verified,
        agent: this.agent,
        tenant: this.tenant,
        at: status.at,
      });
    }
    if (!status.verified) {
      // Only reachable when the caller explicitly opted into fail-open. The warning is already in
      // the local audit trail; here we return the status so the guarded action may proceed.
      if (!this.allowFailOpen) throw new KillSwitchUnavailableError('state present but unverified');
      return status;
    }
    if (status.fetchedAt !== null) {
      const age = this.now() - status.fetchedAt;
      if (age > this.maxStaleSeconds && !this.allowFailOpen) {
        await this.recordLocal('refused', 'verified state is stale', status.epoch, true);
        throw new KillSwitchStaleError(age, this.maxStaleSeconds);
      }
    }
    return status;
  }

  private requireVerifiedStatus(): KillSwitchStatus {
    if (!this.status) {
      throw new KillSwitchUnavailableError('no kill-switch state has been established yet');
    }
    return this.status;
  }

  /* ------------------------------------------------------------------ */
  /* Local halt / resume                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Engage the kill switch locally, right now, with no network call. This is the operator's panic
   * button and the agent's own circuit breaker (429 flood, policy violation, anomalous action
   * rate). It is recorded in the local audit trail, and a best-effort report is sent to the control
   * plane so the tenant-wide view eventually agrees.
   */
  async haltLocal(reason: string, evidence = 'LOCAL-OPERATOR'): Promise<KillSwitchStatus> {
    const at = this.now();
    const epoch = Math.max(this.highestEpoch, this.status?.epoch ?? 0) + 1;
    this.highestEpoch = epoch;
    const status: KillSwitchStatus = {
      halted: true,
      reason: `local halt: ${reason}`,
      epoch,
      origin: 'local',
      verified: false,
      tenant: this.tenant,
      agent: this.agent,
      at,
      fetchedAt: null,
    };
    this.status = status;
    await this.recordLocal('local_halt', status.reason, epoch, false);
    this.emit({ type: 'local_halt', at, epoch, reason: status.reason, origin: 'local' });
    void this.reportLocalHalt(reason, evidence);
    return status;
  }

  /**
   * Clear a local halt. Requires a *verified* control-plane state that is newer than the local halt
   * — so a stale cache cannot be used to sneak an agent back into service. `breakGlass` bypasses
   * that requirement but demands a reason and is recorded as such in the audit trail.
   */
  async resumeLocal(options: { reason: string; evidence?: string; breakGlass?: boolean } = { reason: 'operator resume' }):
    Promise<KillSwitchStatus> {
    if (!this.localHalted) {
      return this.checkStatus();
    }
    const at = this.now();
    if (options.breakGlass === true) {
      if (!options.reason || options.reason.trim().length === 0) {
        throw new KillSwitchLocalHaltError('break-glass resume requires a non-empty reason');
      }
      await this.recordLocal('fail_open_warning', `break-glass resume: ${options.reason}`, this.status?.epoch ?? null, false);
    } else {
      const attempted = this.status?.epoch ?? 0;
      const refreshed = await this.refresh(true);
      if (refreshed.halted || refreshed.origin === 'local' || refreshed.epoch <= attempted) {
        throw new KillSwitchLocalHaltError(
          'no verified control-plane state newer than the local halt is available',
        );
      }
      this.status = refreshed;
      await this.recordLocal('local_resume', options.reason, refreshed.epoch, true);
      this.emit({ type: 'local_resume', at, epoch: refreshed.epoch, reason: options.reason, origin: 'control-plane' });
      return refreshed;
    }

    // Break-glass path: clear the local halt but require the next action to re-verify.
    const cleared: KillSwitchStatus = {
      halted: false,
      reason: `local halt cleared by break-glass: ${options.reason}`,
      epoch: this.status?.epoch ?? 0,
      origin: 'control-plane',
      verified: false,
      tenant: this.tenant,
      agent: this.agent,
      at,
      fetchedAt: null,
    };
    this.status = cleared;
    await this.recordLocal('local_resume', cleared.reason, cleared.epoch, false);
    this.emit({ type: 'local_resume', at, epoch: cleared.epoch, reason: cleared.reason, origin: 'local' });
    return cleared;
  }

  /** Best-effort: tell the control plane this client stopped itself. */
  async reportLocalHalt(reason: string, evidence = 'CLIENT-REPORT'): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/v1/killswitch/report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ tenant: this.tenant, agent: this.agent, reason, evidence }),
      });
      return response.ok;
    } catch {
      // Reporting is advisory. The local halt stands regardless.
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Verified status API                                                 */
  /* ------------------------------------------------------------------ */

  /** Fetch the signed state (no verification). Exposed mainly for tests and diagnostics. */
  async fetchState(): Promise<SignedKillSwitchState> {
    const url = `${this.baseUrl}/api/v1/killswitch/state?tenant=${encodeURIComponent(this.tenant)}&agent=${encodeURIComponent(this.agent)}`;
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      throw new KillSwitchUnavailableError(`control plane rejected the credential (HTTP ${response.status})`);
    }
    if (response.status === 429) {
      // The historical fail-open trigger: a rate-limited client must NOT conclude "allow".
      throw new KillSwitchUnavailableError('control plane rate limited this client (HTTP 429)');
    }
    if (!response.ok) {
      throw new KillSwitchUnavailableError(`control plane returned HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > 64 * 1024) throw new KillSwitchUnavailableError('state response is implausibly large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new KillSwitchUnavailableError('state response is not valid JSON');
    }
    const candidate = parsed as {
      token?: unknown;
      claims?: unknown;
      server_time?: unknown;
      state?: { token?: unknown; claims?: unknown };
    };
    // Due forme legittime sullo stesso endpoint, e accettarle entrambe e' deliberato:
    //  - `{ token, claims, server_time }`     (forma piatta);
    //  - `{ state: { token, claims }, audit, replayed }`  (busta canonica del control plane).
    // La lezione: accettare la busta NON basta, va anche NORMALIZZATA. La prima versione
    // controllava entrambe le posizioni ma restituiva l'oggetto originale, quindi il chiamante
    // leggeva `state.token` su una busta e otteneva `undefined` -> "malformed compact JWS".
    // Un controllo e la sua normalizzazione devono stare nello stesso posto.
    const flat = typeof candidate?.token === 'string' && candidate.token.length > 0 ? candidate : null;
    const nested =
      !flat &&
      candidate?.state &&
      typeof candidate.state.token === 'string' &&
      candidate.state.token.length > 0
        ? candidate.state
        : null;
    const source = flat ?? nested;
    if (source === null) {
      throw new KillSwitchUnavailableError('state response carries no signed token');
    }
    return {
      token: source.token as string,
      claims: source.claims,
      server_time: typeof candidate.server_time === 'number' ? candidate.server_time : 0,
    } as SignedKillSwitchState;
  }

  /** Fetch (and cache) the verification keys, once. Idempotent. */
  async ensureKeys(): Promise<void> {
    if (this.jwksLoaded || this.keyStore.size > 0) {
      this.jwksLoaded = true;
      return;
    }
    const document = await fetchJwks(`${this.baseUrl}/.well-known/anterislab-jwks.json`, this.fetchImpl);
    if (document === null) {
      throw new KillSwitchUnavailableError('verification keys could not be loaded');
    }
    this.keyStore.loadJwks(document);
    this.jwksLoaded = this.keyStore.size > 0;
    if (!this.jwksLoaded) {
      throw new KillSwitchUnavailableError('the published JWKS contains no usable verification key');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Push propagation                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Open the SSE stream so effectively-unguarded agents still learn about a halt within
   * milliseconds. State received on the stream goes through the SAME verification path as a poll:
   * transport is never a substitute for a signature.
   */
  async startStream(): Promise<() => void> {
    await this.ensureKeys().catch(() => undefined);
    const controller = new AbortController();
    this.streamController?.abort();
    this.streamController = controller;
    const url = `${this.baseUrl}${this.streamPath}?tenant=${encodeURIComponent(this.tenant)}&agent=${encodeURIComponent(this.agent)}`;

    void (async () => {
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${this.apiKey}`, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new KillSwitchUnavailableError(`stream refused (HTTP ${response.status})`);
        }
        await this.recordLocal('stream_open', 'SSE stream opened', this.status?.epoch ?? null, false);
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator = buffer.indexOf('\n\n');
          while (separator >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            await this.handleStreamFrame(frame);
            separator = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.emit({
            type: 'error',
            at: this.now(),
            reason: `stream closed: ${error instanceof Error ? error.message : String(error)}`,
            origin: 'control-plane',
          });
        }
      }
    })();

    return () => {
      controller.abort();
      if (this.streamController === controller) this.streamController = null;
    };
  }

  private async handleStreamFrame(frame: string): Promise<void> {
    const eventName = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim() ?? 'message';
    const dataLine = /^data:\s*(.+)$/m.exec(frame)?.[1];
    if (!dataLine) return;
    if (eventName === 'ping') return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLine);
    } catch {
      return;
    }
    const token = (payload as { token?: unknown })?.token ?? (payload as { state?: { token?: unknown } })?.state?.token;
    if (typeof token !== 'string') return;
    const result = await this.verifyStatus(token);
    if (!result.ok) {
      this.emit({ type: 'error', at: this.now(), reason: `rejected streamed state: ${result.detail}`, origin: 'control-plane' });
      return;
    }
    this.status = statusFromClaims(result.claims, this.now(), token);
    await this.recordLocal('state_applied', result.claims.reason, result.claims.epoch, true);
    this.emit({
      type: result.claims.state === 'HALTED' ? 'halted' : 'resumed',
      at: this.now(),
      epoch: result.claims.epoch,
      reason: result.claims.reason,
      origin: 'control-plane',
    });
  }

  stopStream(): void {
    this.streamController?.abort();
    this.streamController = null;
  }

  /* ------------------------------------------------------------------ */
  /* Local audit trail                                                   */
  /* ------------------------------------------------------------------ */

  /** Export the local hash-chained trail (append to the server chain during an investigation). */
  auditTrail(): LocalAuditEntry[] {
    return [...this.localAudit];
  }

  /** Recompute the local chain and report the first broken link, if any. */
  async verifyAuditTrail(): Promise<{ valid: boolean; length: number; broken_at?: number }> {
    let previous = GENESIS;
    let expectedSeq = 1;
    for (const entry of this.localAudit) {
      if (entry.seq !== expectedSeq || entry.prev_hash !== previous) {
        return { valid: false, length: this.localAudit.length, broken_at: entry.seq };
      }
      const recomputed = await this.digestHex(
        canonicalize({
          action: entry.action,
          at: entry.at,
          epoch: entry.epoch,
          prev_hash: entry.prev_hash,
          reason: entry.reason,
          seq: entry.seq,
          verified: entry.verified,
        }),
      );
      if (recomputed !== entry.hash) {
        return { valid: false, length: this.localAudit.length, broken_at: entry.seq };
      }
      previous = entry.hash;
      expectedSeq += 1;
    }
    return { valid: true, length: this.localAudit.length };
  }

  private async recordLocal(
    action: LocalAuditEntry['action'],
    reason: string,
    epoch: number | null,
    verified: boolean,
  ): Promise<LocalAuditEntry> {
    const at = this.now();
    const seq = ++this.auditSeq;
    const prev_hash = this.localAuditHead;
    const hash = await this.digestHex(
      canonicalize({ action, at, epoch, prev_hash, reason, seq, verified }),
    );
    const entry: LocalAuditEntry = { seq, at, action, reason, epoch, verified, prev_hash, hash };
    this.localAudit.push(entry);
    this.localAuditHead = hash;
    // Bound memory in a long-lived agent; the server-side chain is the durable record.
    if (this.localAudit.length > 1000) this.localAudit = this.localAudit.slice(-500);
    return entry;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private failClosedResult(detail: string, at: number): KillSwitchStatus {
    if (this.allowFailOpen) {
      void this.recordLocal('fail_open_warning', `proceeding without kill-switch state: ${detail}`, this.status?.epoch ?? null, false);
      this.emit({ type: 'error', at, reason: `FAIL-OPEN engaged: ${detail}`, origin: 'control-plane' });
      return {
        halted: false,
        reason: `fail-open: ${detail}`,
        epoch: this.status?.epoch ?? 0,
        origin: 'control-plane',
        verified: false,
        tenant: this.tenant,
        agent: this.agent,
        at,
        fetchedAt: null,
      };
    }
    const reason = `kill-switch state unavailable: ${detail}`;
    void this.recordLocal('refused', reason, this.status?.epoch ?? 0, false);
    this.emit({ type: 'refused', at, reason, origin: 'control-plane' });
    return {
      halted: true,
      reason,
      epoch: this.status?.epoch ?? 0,
      origin: 'control-plane',
      verified: false,
      tenant: this.tenant,
      agent: this.agent,
      at,
      fetchedAt: null,
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
    } finally {
      clearTimeout(timer);
    }
  }
}

function statusFromClaims(claims: KillSwitchClaims, at: number, token: string): KillSwitchStatus {
  return {
    halted: claims.state === 'HALTED',
    reason: claims.reason,
    epoch: claims.epoch,
    origin: 'control-plane',
    verified: true,
    tenant: claims.sub,
    agent: claims.scope.agent ?? '*',
    at,
    fetchedAt: at,
    token,
  };
}

async function defaultDigestHex(input: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new KillSwitchConfigError('no WebCrypto available for the local audit chain');
  const digest = await subtle.digest('SHA-256', utf8Encode(input) as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Re-exported so callers can build a token fixture or inspect an epoch without extra imports. */
export { b64uToBytes, bytesToB64u };
export type { KillSwitchErrorDetails };
