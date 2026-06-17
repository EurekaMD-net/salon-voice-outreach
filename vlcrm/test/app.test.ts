import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createApp } from "../src/app.js";
import type { LeadEvent } from "../src/lead-event.js";

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("vlcrm HTTP app", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("GET /healthz is live", async () => {
    const app = createApp(db);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /leads/intake captures a sales-phone lead with a referred-by", async () => {
    const app = createApp(db);
    const res = await app.request(
      "/leads/intake",
      json({
        name: "Salón Glamour",
        phone: "+52 155 1234 5678",
        colonia: "Iztapalapa",
        contactName: "María",
        role: "Dueña",
        referredByName: "Cliente Pedro",
        referredByPhone: "+5215588887777",
        notes: "Pidió info de citas",
      }),
    );
    expect(res.status).toBe(201);
    const out = (await res.json()) as { created: boolean; stage: string };
    expect(out.created).toBe(true);
    expect(out.stage).toBe("contacted");

    // phone normalized to the canonical account_key
    const read = await app.request(
      `/accounts/${encodeURIComponent("+5215512345678")}`,
    );
    expect(read.status).toBe(200);
    const data = (await read.json()) as {
      account: {
        source: string;
        referred_by_name: string;
        referred_by_phone: string;
      };
      interactions: { channel: string; type: string }[];
    };
    expect(data.account.source).toBe("sales_phone");
    expect(data.account.referred_by_name).toBe("Cliente Pedro");
    expect(data.account.referred_by_phone).toBe("+5215588887777");
    expect(data.interactions).toHaveLength(1);
    expect(data.interactions[0]!.channel).toBe("sales_phone");
    expect(data.interactions[0]!.type).toBe("manual_intake");
  });

  it("POST /leads/intake rejects a lead with neither name nor phone", async () => {
    const app = createApp(db);
    const res = await app.request("/leads/intake", json({ notes: "nada" }));
    expect(res.status).toBe(400);
  });

  it("POST /leads/intake works with a name only (no phone) — generated key", async () => {
    const app = createApp(db);
    const res = await app.request(
      "/leads/intake",
      json({ name: "Barbería Sin Tel", referredByName: "Vecino" }),
    );
    expect(res.status).toBe(201);
    const n = db.prepare("SELECT COUNT(*) n FROM account").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });

  it("POST /events ingests a raw LeadEvent (the agnostic port)", async () => {
    const app = createApp(db);
    const ev: LeadEvent = {
      accountKey: "denue-123",
      channel: "voice",
      direction: "outbound",
      type: "call",
      source: "denue",
      outcome: "no_answer",
      costCents: 40,
    };
    const res = await app.request("/events", json(ev));
    expect(res.status).toBe(201);
    const out = (await res.json()) as { created: boolean; stage: string };
    expect(out.created).toBe(true);
    expect(out.stage).toBe("contacted");
  });

  it("POST /events fails closed on an invalid channel (400)", async () => {
    const app = createApp(db);
    const res = await app.request(
      "/events",
      json({
        accountKey: "k",
        channel: "smoke-signal",
        direction: "outbound",
        type: "call",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  it("POST /events rejects a malformed JSON body (400)", async () => {
    const app = createApp(db);
    const res = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid",
    });
    expect(res.status).toBe(400);
  });

  it("GET /accounts/:key returns 404 for an unknown account", async () => {
    const app = createApp(db);
    const res = await app.request("/accounts/nope");
    expect(res.status).toBe(404);
  });

  describe("bearer guard (apiKey set)", () => {
    const KEY = "s3cret-key-at-least-16-chars";
    it("rejects mutating routes without / with a wrong bearer (401)", async () => {
      const app = createApp(db, { apiKey: KEY });
      const noAuth = await app.request("/leads/intake", json({ name: "X" }));
      expect(noAuth.status).toBe(401);
      const wrong = await app.request(
        "/leads/intake",
        json({ name: "X" }, { authorization: "Bearer wrong" }),
      );
      expect(wrong.status).toBe(401);
    });

    it("gates the /accounts/:key PII read too (401 without auth)", async () => {
      const app = createApp(db, { apiKey: KEY });
      const res = await app.request("/accounts/anything");
      expect(res.status).toBe(401);
    });

    it("allows the correct bearer", async () => {
      const app = createApp(db, { apiKey: KEY });
      const ok = await app.request(
        "/leads/intake",
        json({ name: "X" }, { authorization: `Bearer ${KEY}` }),
      );
      expect(ok.status).toBe(201);
    });

    it("leaves /healthz open even with a key set", async () => {
      const app = createApp(db, { apiKey: KEY });
      const res = await app.request("/healthz");
      expect(res.status).toBe(200);
    });

    it("fails CLOSED on a present-but-blank/short key (misconfig throws)", () => {
      expect(() => createApp(db, { apiKey: "" })).toThrow(/at least 16/i);
      expect(() => createApp(db, { apiKey: "short" })).toThrow(/at least 16/i);
    });
  });
});
