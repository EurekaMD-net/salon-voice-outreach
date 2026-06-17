/**
 * The pipesong PORT — the only seam the orchestrator touches the voice engine
 * through. Keeping it an interface (not a hard HTTP call) is deliberate: pipesong
 * is being upgraded in a parallel session (Pipecat 1.x / Flux / Qwen3), so the
 * concrete HTTP adapter is written LAST, against the re-verified contract. The
 * orchestrator core depends only on this interface — a pipesong change is a
 * one-adapter update, never a core rewrite.
 *
 * Real adapter (deferred): `HttpPipesongClient` → `POST /calls/outbound`
 * `{ agent_id, to_number, variables }` (PIPESONG-NOTES §1, verified-as-of 2026-06-17).
 */

export interface OriginateParams {
  /** pipesong agent id (the salon-opener). */
  agentId: string;
  /** Destination, E.164. */
  toNumber: string;
  /** Per-call template vars injected into the agent prompt (`{{nombre}}`, `{{colonia}}`). */
  variables: Record<string, string>;
}

export interface OriginateResult {
  /** pipesong call id (joins to our `call_attempt.pipesong_call_id`). */
  callId: string;
}

export interface PipesongClient {
  /** Place one outbound call. Throws if origination fails (the dialer treats a
   *  throw as a `failed` disposition — no webhook will arrive for a call that
   *  never started). */
  originateCall(params: OriginateParams): Promise<OriginateResult>;
}

/**
 * In-memory fake for tests and the minimum-stack dry run. Records every
 * origination; can be told to fail to exercise the dialer's failure path.
 */
export class FakePipesongClient implements PipesongClient {
  readonly calls: OriginateParams[] = [];
  private seq = 0;

  constructor(private readonly opts: { fail?: boolean } = {}) {}

  async originateCall(params: OriginateParams): Promise<OriginateResult> {
    if (this.opts.fail) throw new Error("pipesong unavailable (fake)");
    this.calls.push(params);
    this.seq += 1;
    return { callId: `fake-call-${this.seq}` };
  }
}
