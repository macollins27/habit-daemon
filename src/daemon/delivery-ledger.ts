// Claim ledger for escalation deliveries — at-most-once posting with an
// explicit, detectable in-doubt state.
//
// WHAT THIS CAN AND CANNOT GUARANTEE
// ----------------------------------
// Exactly-once delivery is NOT achievable against the Discord API. Discord's
// message-create endpoint accepts no idempotency key, so there is no way to say
// "post this, and if you already did, don't do it twice". Any crash between the
// network write and the local acknowledgement leaves genuine ambiguity: the
// message may or may not exist.
//
// What IS achievable, and what this implements, is AT-MOST-ONCE with an
// auditable in-doubt state:
//
//   * intent is recorded BEFORE the irreversible post, so a crash always leaves
//     evidence that an attempt was in flight;
//   * the (run, level) primary key makes two concurrent workers physically
//     unable to both claim the same logical delivery;
//   * a delivery found still in flight is never blindly retried — it is
//     surfaced for reconciliation, because a blind retry is how one crash
//     becomes two messages in the operator's channel.
//
// The residual case — an in-doubt delivery whose true outcome is only knowable
// by reading channel history — is left to a human or a reconciliation pass, and
// is deliberately visible rather than silently resolved either way.

import type Database from "better-sqlite3";

export type ClaimOutcome =
  /** The claim is ours; proceed with the post. */
  | "claimed"
  /** This exact delivery already went out. Do nothing. */
  | "already_delivered"
  /** A previous attempt died mid-post. Outcome unknown — do NOT post. */
  | "in_doubt";

export interface DeliveryRow {
  readonly delivery_key: string;
  readonly run_id: string;
  readonly level: number;
  readonly state: "in_flight" | "delivered" | "abandoned";
  readonly message_id: string | null;
  readonly worker: string | null;
  readonly attempt_started_at: number;
  readonly completed_at: number | null;
  readonly resolved_note: string | null;
}

/** The stable identity of one logical delivery. */
export function deliveryKey(runId: string, level: number): string {
  return `${runId}:${String(level)}`;
}

export function readDelivery(
  db: Database.Database,
  runId: string,
  level: number,
): DeliveryRow | null {
  try {
    const row = db
      .prepare(`SELECT * FROM escalation_deliveries WHERE delivery_key = ?`)
      .get(deliveryKey(runId, level)) as DeliveryRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Claim the right to post this (run, level) exactly once.
 *
 * Written as a single INSERT guarded by the primary key so the check and the
 * claim cannot interleave: two workers racing here, the loser gets a constraint
 * violation and is told the delivery is in doubt rather than being allowed to
 * post a duplicate.
 */
export function beginDelivery(
  db: Database.Database,
  runId: string,
  level: number,
  nowMs: number,
  worker: string,
): ClaimOutcome {
  const key = deliveryKey(runId, level);
  try {
    db.prepare(
      `INSERT INTO escalation_deliveries
         (delivery_key, run_id, level, state, worker, attempt_started_at)
       VALUES (?, ?, ?, 'in_flight', ?, ?)`,
    ).run(key, runId, level, worker, nowMs);
    return "claimed";
  } catch {
    const existing = readDelivery(db, runId, level);
    if (existing === null) {
      // The table is absent (legacy/minimal schema). Fail OPEN so a missing
      // safety net never stops the operator's check-ins going out; the older
      // behaviour is no worse than it was before this table existed.
      return "claimed";
    }
    if (existing.state === "delivered") return "already_delivered";
    if (existing.state === "abandoned") {
      // A previous attempt failed before posting anything, so re-claiming is
      // safe: nothing reached the channel.
      db.prepare(
        `UPDATE escalation_deliveries
            SET state = 'in_flight', worker = ?, attempt_started_at = ?,
                completed_at = NULL
          WHERE delivery_key = ?`,
      ).run(worker, nowMs, key);
      return "claimed";
    }
    return "in_doubt";
  }
}

/** The post succeeded and we know its message id. */
export function completeDelivery(
  db: Database.Database,
  runId: string,
  level: number,
  messageId: string | null,
  nowMs: number,
): void {
  try {
    db.prepare(
      `UPDATE escalation_deliveries
          SET state = 'delivered', message_id = ?, completed_at = ?
        WHERE delivery_key = ?`,
    ).run(messageId, nowMs, deliveryKey(runId, level));
  } catch {
    /* table absent */
  }
}

/**
 * The attempt failed BEFORE anything was posted, so the claim is released and
 * a later attempt may take it cleanly. Only ever call this when it is certain
 * nothing reached the channel — releasing a claim after a post is what would
 * re-open the duplicate window.
 */
export function abandonDelivery(
  db: Database.Database,
  runId: string,
  level: number,
  nowMs: number,
): void {
  try {
    db.prepare(
      `UPDATE escalation_deliveries
          SET state = 'abandoned', completed_at = ?
        WHERE delivery_key = ? AND state = 'in_flight'`,
    ).run(nowMs, deliveryKey(runId, level));
  } catch {
    /* table absent */
  }
}

/** Deliveries stuck in flight — a crash happened mid-post. */
export function listInDoubtDeliveries(
  db: Database.Database,
  olderThanMs: number,
): readonly DeliveryRow[] {
  try {
    return db
      .prepare(
        `SELECT * FROM escalation_deliveries
          WHERE state = 'in_flight' AND attempt_started_at <= ?
          ORDER BY attempt_started_at`,
      )
      .all(olderThanMs) as DeliveryRow[];
  } catch {
    return [];
  }
}

/**
 * Record an adjudication of an in-doubt delivery. `didPost` says whether the
 * message was found in the channel; the note records who decided and how.
 */
export function resolveInDoubtDelivery(
  db: Database.Database,
  runId: string,
  level: number,
  didPost: boolean,
  note: string,
  nowMs: number,
): void {
  try {
    db.prepare(
      `UPDATE escalation_deliveries
          SET state = ?, completed_at = ?, resolved_note = ?
        WHERE delivery_key = ?`,
    ).run(didPost ? "delivered" : "abandoned", nowMs, note, deliveryKey(runId, level));
  } catch {
    /* table absent */
  }
}
