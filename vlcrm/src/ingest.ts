import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { LeadEvent } from "./lead-event.js";
import type { Account, PipelineStage } from "./types.js";
import { advanceStage, impliedStage } from "./stage.js";

export interface IngestResult {
  accountId: string;
  /** true if this event created the account, false if it matched an existing one */
  created: boolean;
  interactionId: string;
  stage: PipelineStage;
}

/**
 * Ingest one LeadEvent: upsert the account, log the interaction, optionally record
 * a qualification, and advance the pipeline stage (forward-only). Runs in a single
 * transaction so a half-written lead can never exist.
 *
 * PROVENANCE IS SET-ONCE: `source` and the `referred_by_*` fields are written only
 * when the account is first created. A later event for the same account never
 * rewrites who referred it or how it first arrived — that would corrupt attribution.
 *
 * TIMESTAMPS: every write uses SQL `datetime(...)`. `occurred_at` falls back to
 * `datetime('now')` via COALESCE when the event omits it — we never synthesize a JS
 * ISO string (see schema.ts canonical-timestamp note).
 */
export function ingestLeadEvent(db: DB, event: LeadEvent): IngestResult {
  const tx = db.transaction((): IngestResult => {
    // --- resolve referrer: the row holds EITHER an FK to a known account OR free
    // text, never both (one unambiguous representation — avoids attribution
    // double-counting). FK wins when it resolves; otherwise keep name/phone, or
    // the raw key as a last-resort name so we never drop the only reference. ---
    let referredByAccountId: string | null = null;
    let referredByName: string | null = event.referredBy?.name ?? null;
    let referredByPhone: string | null = event.referredBy?.phone ?? null;
    if (event.referredBy?.accountKey) {
      const ref = db
        .prepare("SELECT id FROM account WHERE account_key = ?")
        .get(event.referredBy.accountKey) as { id: string } | undefined;
      if (ref) {
        referredByAccountId = ref.id;
        referredByName = null; // FK is authoritative — drop the redundant free text
        referredByPhone = null;
      } else if (!referredByName && !referredByPhone) {
        // Referrer not in the CRM and no other identifier given — keep the raw key
        // as a name rather than silently dropping the only reference we have.
        referredByName = event.referredBy.accountKey;
      }
    }

    // --- upsert account by account_key ---
    const existing = db
      .prepare("SELECT * FROM account WHERE account_key = ?")
      .get(event.accountKey) as Account | undefined;

    let accountId: string;
    let created: boolean;
    let currentStage: PipelineStage;

    if (existing) {
      accountId = existing.id;
      created = false;
      currentStage = existing.pipeline_stage;
      // Fill a blank name only; never overwrite provenance.
      if (!existing.name && event.name) {
        db.prepare(
          "UPDATE account SET name = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(event.name, accountId);
      }
    } else {
      accountId = randomUUID();
      created = true;
      currentStage = "new";
      db.prepare(
        `INSERT INTO account
           (id, account_key, name, source,
            referred_by_account_id, referred_by_name, referred_by_phone, attributes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        event.accountKey,
        event.name ?? null,
        event.source ?? "other",
        referredByAccountId,
        referredByName,
        referredByPhone,
        event.attributes !== undefined
          ? JSON.stringify(event.attributes)
          : null,
      );
    }

    // --- upsert contact (if any contact detail was supplied) ---
    let contactId: string | null = null;
    const c = event.contact;
    if (c && (c.name || c.role || c.phone || c.email || c.ig)) {
      if (c.phone) {
        const existingContact = db
          .prepare(
            "SELECT id FROM contact WHERE account_id = ? AND phone_e164 = ?",
          )
          .get(accountId, c.phone) as { id: string } | undefined;
        if (existingContact) {
          contactId = existingContact.id;
          db.prepare(
            `UPDATE contact SET
               name = COALESCE(name, ?), role = COALESCE(role, ?),
               email = COALESCE(email, ?), ig_handle = COALESCE(ig_handle, ?),
               updated_at = datetime('now')
             WHERE id = ?`,
          ).run(
            c.name ?? null,
            c.role ?? null,
            c.email ?? null,
            c.ig ?? null,
            contactId,
          );
        }
      }
      if (!contactId) {
        contactId = randomUUID();
        db.prepare(
          `INSERT INTO contact
             (id, account_id, name, role, phone_e164, email, ig_handle)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          contactId,
          accountId,
          c.name ?? null,
          c.role ?? null,
          c.phone ?? null,
          c.email ?? null,
          c.ig ?? null,
        );
      }
    }

    // --- append the interaction (the spine; cost lives here for CPQL) ---
    const interactionId = randomUUID();
    db.prepare(
      `INSERT INTO interaction
         (id, account_id, contact_id, channel, direction, type,
          outcome, cost_cents, ref_id, payload, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    ).run(
      interactionId,
      accountId,
      contactId,
      event.channel,
      event.direction,
      event.type,
      event.outcome ?? null,
      event.costCents ?? 0,
      event.refId ?? null,
      event.payload !== undefined ? JSON.stringify(event.payload) : null,
      event.occurredAt ?? null,
    );

    // --- qualification (the verdict that makes a lead worth a close) ---
    if (event.qualification) {
      const q = event.qualification;
      db.prepare(
        `INSERT INTO qualification
           (id, account_id, interested, fit, objection, callback_window,
            score, source_interaction_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        accountId,
        q.interested === undefined ? null : q.interested ? 1 : 0,
        q.fit ?? null,
        q.objection ?? null,
        q.callbackWindow ?? null,
        q.score ?? null,
        interactionId,
      );
    }

    // --- advance the stage (forward-only) ---
    let target = impliedStage(event.type);
    if (event.qualification) {
      // a qualification always implies at least "qualified"
      target =
        target === null || target === "new" || target === "contacted"
          ? "qualified"
          : target;
    }
    let stage = currentStage;
    if (target) {
      stage = advanceStage(currentStage, target);
      if (stage !== currentStage) {
        db.prepare(
          "UPDATE account SET pipeline_stage = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(stage, accountId);
      }
    }

    return { accountId, created, interactionId, stage };
  });

  return tx();
}
