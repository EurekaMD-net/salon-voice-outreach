/**
 * The CRM seam — a PORT, same discipline as `PipesongClient`. The orchestrator
 * emits lead events to vlcrm over this interface and couples to nothing about
 * vlcrm's transport. The wire contract is the JSON body that vlcrm's
 * `validateLeadEvent` enforces (a 400 means we drifted — caught in tests).
 *
 * `emit` MUST throw on failure (non-2xx / network error). The outbox pump
 * (`syncPendingLeads`) relies on a throw to leave the row unsynced for retry.
 */

import type { CrmLeadEvent } from "./crm-event.js";

export interface CrmClient {
  emit(event: CrmLeadEvent): Promise<void>;
}

/** In-memory fake for tests. Records every emitted event; can simulate failure. */
export class FakeCrmClient implements CrmClient {
  readonly events: CrmLeadEvent[] = [];
  constructor(private readonly opts: { fail?: boolean } = {}) {}
  async emit(event: CrmLeadEvent): Promise<void> {
    if (this.opts.fail) throw new Error("FakeCrmClient: forced failure");
    this.events.push(event);
  }
}

/**
 * Concrete adapter: POST the event to vlcrm `POST /events`. This contract is
 * OURS (both services in-repo, stable) — unlike the in-flux pipesong seam, so
 * the concrete adapter ships now. Throws on a non-2xx so the pump retries.
 */
export class HttpCrmClient implements CrmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async emit(event: CrmLeadEvent): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vlcrm /events ${res.status}: ${detail.slice(0, 200)}`);
    }
  }
}
