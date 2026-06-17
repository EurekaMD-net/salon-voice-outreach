import { Hono, type MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import {
  validateLeadEvent,
  LeadEventError,
  type LeadEvent,
} from "./lead-event.js";
import { ingestLeadEvent } from "./ingest.js";
import { computeCpql } from "./cpql.js";
import { normalizePhone } from "./phone.js";
import type { Account, Interaction, Qualification } from "./types.js";

export interface AppOptions {
  /**
   * If set, every mutating route requires `Authorization: Bearer <apiKey>`.
   * PRODUCTION MUST SET THIS (the service accepts leads + PII). Left unset only
   * for tests / local dev. Compared with a constant-time check.
   */
  apiKey?: string;
}

function bearerOk(header: string | undefined, apiKey: string): boolean {
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  // constant-time compare to avoid leaking length/match via timing
  if (token.length !== apiKey.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ apiKey.charCodeAt(i);
  }
  return diff === 0;
}

/** Body shape for the operator-facing sales-phone intake form. */
interface IntakeBody {
  name?: unknown;
  phone?: unknown;
  colonia?: unknown;
  ig?: unknown;
  contactName?: unknown;
  role?: unknown;
  email?: unknown;
  referredByName?: unknown;
  referredByPhone?: unknown;
  referredByAccountKey?: unknown;
  notes?: unknown;
  source?: unknown;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * Build the vlcrm HTTP app. `db` is injected so tests pass an in-memory DB.
 *
 * Routes:
 *   GET  /healthz          — liveness
 *   POST /events           — the AGNOSTIC port: ingest a raw LeadEvent (orchestrator,
 *                            WhatsApp closer, web form — any channel emits this).
 *   POST /leads/intake     — operator sales-phone manual intake with a "referred by"
 *                            field; a thin convenience wrapper over /events.
 *   GET  /accounts/:key    — read an account + its interactions + latest qualification.
 */
export function createApp(db: DB, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const apiKey = opts.apiKey;

  // Fail CLOSED on a present-but-weak key: a blank/short `apiKey` (e.g. an unset
  // `API_KEY=` env var passed straight through) must NOT silently boot an open
  // PII service. Omit `apiKey` entirely for local/dev; otherwise it must be real.
  if (apiKey !== undefined && apiKey.trim().length < 16) {
    throw new Error(
      "vlcrm: apiKey must be at least 16 chars (omit it entirely for local/dev only)",
    );
  }

  if (apiKey) {
    const guard: MiddlewareHandler = async (c, next) => {
      if (!bearerOk(c.req.header("authorization"), apiKey)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      await next();
    };
    app.use("/events", guard);
    app.use("/leads/*", guard);
    // /accounts/:key returns PII (names, phones, emails, IG) — gate the read too.
    app.use("/accounts/*", guard);
    // /metrics exposes business-sensitive aggregates (spend, CPQL) — gate it.
    app.use("/metrics/*", guard);
  }

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/events", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const event = validateLeadEvent(body);
      const result = ingestLeadEvent(db, event);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof LeadEventError)
        return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.post("/leads/intake", async (c) => {
    let body: IntakeBody;
    try {
      body = (await c.req.json()) as IntakeBody;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const name = asStr(body.name);
    const phone = normalizePhone(asStr(body.phone));
    // Need at least something to identify the lead by.
    if (!name && !phone) {
      return c.json({ error: "name or phone is required" }, 400);
    }

    const referredBy = {
      name: asStr(body.referredByName),
      phone: normalizePhone(asStr(body.referredByPhone)) ?? undefined,
      accountKey: asStr(body.referredByAccountKey),
    };
    const hasReferral =
      referredBy.name || referredBy.phone || referredBy.accountKey;

    const payload: Record<string, string> = {};
    const colonia = asStr(body.colonia);
    const notes = asStr(body.notes);
    if (colonia) payload.colonia = colonia;
    if (notes) payload.notes = notes;

    const event: LeadEvent = {
      accountKey: phone ?? `manual:${randomUUID()}`,
      channel: "sales_phone",
      direction: "inbound",
      type: "manual_intake",
      source: "sales_phone",
      name,
      contact: {
        name: asStr(body.contactName) ?? name,
        role: asStr(body.role),
        phone: phone ?? undefined,
        email: asStr(body.email),
        ig: asStr(body.ig),
      },
      referredBy: hasReferral ? referredBy : undefined,
      payload: Object.keys(payload).length ? payload : undefined,
    };

    try {
      const validated = validateLeadEvent(event);
      const result = ingestLeadEvent(db, validated);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof LeadEventError)
        return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.get("/accounts/:key", (c) => {
    const key = c.req.param("key");
    const account = db
      .prepare("SELECT * FROM account WHERE account_key = ?")
      .get(key) as Account | undefined;
    if (!account) return c.json({ error: "not found" }, 404);
    const interactions = db
      .prepare(
        "SELECT * FROM interaction WHERE account_id = ? ORDER BY occurred_at DESC",
      )
      .all(account.id) as Interaction[];
    const qualification = db
      .prepare(
        "SELECT * FROM qualification WHERE account_id = ? ORDER BY captured_at DESC LIMIT 1",
      )
      .get(account.id) as Qualification | undefined;
    return c.json({
      account,
      interactions,
      qualification: qualification ?? null,
    });
  });

  app.get("/metrics/cpql", (c) => c.json(computeCpql(db)));

  return app;
}
