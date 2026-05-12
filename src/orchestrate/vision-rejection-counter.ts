// Task 19: orchestration verb that records a vision-verify rejection and
// flips `habit_runs.proof_rejection_callout_due` to 1 once three rejections
// have accumulated for a single run.
//
// Why this exists / decoupling contract:
//   Vision-verify must stay decoupled from discord-adapter (testable in CLI,
//   web-admin, and future v2 contexts). This verb writes ONLY two things:
//     1. A 'proof_attempt_rejected' event to `session_events` (always).
//     2. `habit_runs.proof_rejection_callout_due = 1` (once, on the 0→1 0
//        transition triggered by the 3rd rejection for that run).
//   It does NOT compose the user-visible callout, dispatch to Discord, or
//   reset the flag. The callout text is built inside the next habit-checkin
//   prompt builder (Task 24+) when it sees the flag set, and habit-checkin
//   is the writer that resets the flag after a successful dispatch.
//
// Why `next_escalation_at` is left alone:
//   Rejections do NOT move escalation. The callout piggybacks on the
//   already-scheduled L+1 dispatch (the rejection happened before completion
//   so the run is still escalating). The cron-scheduled dispatch reads the
//   flag at send time. Modifying next_escalation_at here would either fire
//   the callout twice (extra dispatch) or skip the natural L+1 (lost
//   escalation cadence). Tests assert next_escalation_at is unchanged across
//   every rejection path.
//
// Counter query:
//   `session_events.event_type` is the typed taxonomy column (CHECK
//   constraint enforces 'proof_attempt_rejected' as a valid value). The
//   `runId` is carried INSIDE `event_json` (not a top-level column), so the
//   counter uses `json_extract(event_json, '$.runId') = ?`. better-sqlite3
//   bundles SQLite ≥ 3.38 which supports `json_extract` natively. The
//   COUNT runs AFTER the new event has been inserted in the same
//   transaction — the count is therefore the post-insert total for this run.
//
// Single-writer constraint (Task 15 pattern):
//   Both the session_events INSERT and the habit_runs UPDATE share a single
//   better-sqlite3 transaction on `sessionStore.db`. SQLite WAL only permits
//   one writer at a time; passing a separate Database connection would
//   deadlock on SQLITE_BUSY. The verb derives `db` from `sessionStore.db`
//   internally so callers cannot pass a wrong handle. better-sqlite3 uses
//   SAVEPOINT for nested transactions, so the inner transaction inside
//   `SessionStore.append()` composes correctly.
//
// Trust level rationale:
//   The rejection event is recorded at L1 ("claim + artifact"). The proof
//   attempt has both a Discord message (the user's submission) and an image
//   URL; vision-verify produced parseable model output that simply failed a
//   threshold or schema check. The artifact is real even though the claim
//   was rejected — L1 fits.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 19
//   - src/daemon/session-store.ts (append() semantics, event_type CHECK)
//   - src/db/migrations/001_habits.sql (habit_runs.proof_rejection_callout_due)
//   - src/orchestrate/resolve-sensor-failure.ts (single-writer pattern, prior art)

import type { SessionStore } from "../daemon/session-store.js";

export interface VisionRejection {
  readonly subject: string; // 'pm5_screen' | 'training_log' — registry subject
  readonly reason?: string; // schema/threshold rejection reason from verifyImage
  readonly parsed?: unknown; // model's parsed output (for audit)
}

export interface RecordVisionRejectionOptions {
  readonly sessionStore: SessionStore;
  readonly sessionId: string;
  readonly runId: string;
  readonly rejection: VisionRejection;
}

export interface RejectionCounterResult {
  /** Total rejections for this run after the current call's append. */
  readonly rejectionCount: number;
  /**
   * True iff THIS call caused `proof_rejection_callout_due` to transition
   * 0 → 1 (i.e., this was the 3rd rejection and the flag was previously 0).
   * Subsequent rejections at counts 4, 5, … report false.
   */
  readonly calloutDueSet: boolean;
  /** True iff the flag was already 1 BEFORE this call. */
  readonly calloutAlreadyDue: boolean;
}

// The hash-chain canonicalizer (aat-chain.jsonCanonicalize) rejects
// `undefined` because it has no JSON representation. We therefore omit
// optional fields when they're absent rather than serializing them as
// `undefined`. The shape below uses a type alias rather than `interface`
// so we can build it with conditional spreads.
type RejectionEventPayload = {
  readonly runId: string;
  readonly subject: string;
} & (
  | { readonly reason: string }
  | { readonly reason?: never }
) & (
  | { readonly parsed: unknown }
  | { readonly parsed?: never }
);

interface CalloutDueRow {
  readonly proof_rejection_callout_due: number;
}

interface CountRow {
  readonly n: number;
}

const THRESHOLD = 3;

export function recordVisionRejection(
  opts: RecordVisionRejectionOptions,
): RejectionCounterResult {
  const { sessionStore, sessionId, runId, rejection } = opts;
  const db = sessionStore.db;

  // Build the payload omitting any optional field whose value is undefined.
  // The canonical-JSON hasher (aat-chain.jsonCanonicalize) throws on
  // `undefined` because it has no JSON representation, so we cannot pass
  // `{reason: undefined}` even though TypeScript would permit it.
  const payload: RejectionEventPayload = {
    runId,
    subject: rejection.subject,
    ...(rejection.reason !== undefined ? { reason: rejection.reason } : {}),
    ...(rejection.parsed !== undefined ? { parsed: rejection.parsed } : {}),
  };

  const run = db.transaction((): RejectionCounterResult => {
    // 1. Read current flag state. Throw atomically if the run does not exist.
    //    Doing this BEFORE the append ensures no orphan event is written for
    //    a non-existent run (test: unknown runId throws atomically).
    const flagRow = db
      .prepare(
        `SELECT proof_rejection_callout_due FROM habit_runs WHERE id = ?`,
      )
      .get(runId) as CalloutDueRow | undefined;

    if (flagRow === undefined) {
      throw new Error(`habit_run not found: ${runId}`);
    }

    const calloutAlreadyDue = flagRow.proof_rejection_callout_due === 1;

    // 2. Append the rejection event. L1: artifact-backed (image URL + parseable
    //    model output). SessionStore.append() handles seq, prev_hash, and
    //    session row creation idempotently.
    sessionStore.append(sessionId, "proof_attempt_rejected", payload, {
      trustLevel: "L1",
    });

    // 3. Count rejections for THIS run only. `runId` lives inside event_json,
    //    so json_extract($.runId) is required for run-scoped isolation.
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_events
         WHERE event_type = 'proof_attempt_rejected'
           AND json_extract(event_json, '$.runId') = ?`,
      )
      .get(runId) as CountRow;
    const rejectionCount = countRow.n;

    // 4. Set the flag iff this rejection caused a 0→1 transition. Subsequent
    //    rejections at counts 4, 5, … are no-ops on the flag (idempotent).
    let calloutDueSet = false;
    if (rejectionCount >= THRESHOLD && !calloutAlreadyDue) {
      db.prepare(
        `UPDATE habit_runs SET proof_rejection_callout_due = 1 WHERE id = ?`,
      ).run(runId);
      calloutDueSet = true;
    }

    return { rejectionCount, calloutDueSet, calloutAlreadyDue };
  });

  return run();
}
