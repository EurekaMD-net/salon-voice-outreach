import type { DB } from "./db.js";
import type { Config } from "./config.js";
import type { CrmClient } from "./crm-client.js";
import { buildCrmEvent, type CrmSyncRow } from "./crm-event.js";

export interface SyncResult {
  /** events accepted by the CRM and marked synced this run */
  synced: number;
  /** events the CRM rejected / failed to receive (left unsynced for retry) */
  failed: number;
}

/**
 * Outbox pump: drain finalized-but-unsynced `call_attempt` rows to vlcrm. The
 * capture-first `call_attempt` table IS the outbox — no separate queue, and
 * nothing is lost if vlcrm is down (the row simply stays unsynced and retries).
 *
 * DELIVERY = at-least-once: we emit, then mark `crm_synced_at`. A crash between
 * the two re-emits on the next run (a duplicate interaction at vlcrm). `refId` is
 * the call_attempt id, so exactly-once is a future vlcrm-side dedup on that key.
 *
 * ORDERING: per-row sequential (not batched-concurrent) so a mid-batch failure
 * cleanly leaves the rest unsynced; cheap at pilot volume. `datetime('now')` for
 * the sync stamp (canonical TEXT format — never JS toISOString, QA M2).
 */
export async function syncPendingLeads(
  db: DB,
  cfg: Config,
  crm: CrmClient,
): Promise<SyncResult> {
  const rows = db
    .prepare(
      `SELECT ca.id            AS call_attempt_id,
              ca.campaign_id   AS campaign_id,
              ca.pipesong_call_id AS pipesong_call_id,
              ca.disposition   AS disposition,
              ca.duration_s    AS duration_s,
              p.phone_e164     AS phone_e164,
              p.name           AS name,
              p.colonia        AS colonia,
              p.ig_handle      AS ig_handle,
              p.source         AS source
         FROM call_attempt ca
         JOIN prospect p ON p.id = ca.prospect_id
        WHERE ca.disposition IS NOT NULL
          AND ca.crm_synced_at IS NULL
          -- QA W1: exclude un-emittable rows. vlcrm rejects accountKey='' with a
          -- 400, which would leave the row unsynced and re-rejected forever (a
          -- poison-pill that can also head-of-line-block a full batch). NOT NULL
          -- still permits '' in SQLite, so guard it explicitly here. The real fix
          -- is E.164 validation at the (not-yet-built) prospect import boundary.
          AND p.phone_e164 IS NOT NULL
          AND p.phone_e164 <> ''
        ORDER BY ca.started_at ASC, ca.id ASC -- QA R2: stable batch boundaries
        LIMIT ?`,
    )
    .all(cfg.crmSyncBatch) as CrmSyncRow[];

  const markSynced = db.prepare(
    "UPDATE call_attempt SET crm_synced_at = datetime('now') WHERE id = ?",
  );

  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await crm.emit(buildCrmEvent(row, cfg));
      markSynced.run(row.call_attempt_id);
      synced += 1;
    } catch {
      // Leave crm_synced_at NULL → retried next run. One bad row doesn't block
      // the pump from being re-tried; we simply count it and move on.
      failed += 1;
    }
  }
  return { synced, failed };
}
