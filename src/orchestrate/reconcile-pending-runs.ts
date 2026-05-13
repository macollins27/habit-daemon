// Task 1.1 / 1.2: Reconcile pending habit runs against external sensor signals.
//
// This orchestrator closes habit_runs that are still in a pending state when
// the underlying sensor data (Concept2, Garmin) shows up after the daemon
// has already prompted (or stopped prompting) the user. Without it, the
// daemon nags the user after they have already completed the activity.
//
// Phase 1 wiring is layered across follow-up tasks:
//   - 1.2: Concept2 sync + run completion logic (this task)
//   - 1.3: Garmin sync + run completion logic
//   - 1.4: idempotency (skip already-resolved runs, no duplicate posts)
//   - 1.5: cron wiring (`*/2 * * * *`) and production integration
//
// Production wiring (Task 1.5) is responsible for resolving `"wins"` (a
// channel-name keyword) and the per-habit `channel_id` (a Discord
// snowflake) when calling `postCompletion`. This file just emits the two
// channel ids verbatim — that asymmetry is intentional and matches the
// `postToChannel` pattern used elsewhere.

import type Database from "better-sqlite3";
import type { SessionStore } from "../daemon/session-store.js";
import type { Concept2Result } from "../lib/concept2-adapter.js";
import { findQualifyingSession } from "./verify-proof-internals.js";

// -----------------------------------------------------------------------------
// Public surface (pinned in Task 1.1).
// -----------------------------------------------------------------------------

export interface ReconcileResult {
  readonly attempted: number;
  readonly completed: number;
  readonly stillPending: number;
}

export interface ReconcileOptions {
  readonly sessionStore: SessionStore;
  readonly now: number;
  /**
   * Refresh the Concept2 cache for the run's date. The wrapper MUST cause
   * `sensor_signals` to be keyed by the run's local `fire_date` — the
   * reconciler later reads `sensor_signals` using that local-date key.
   *
   * The underlying adapter (`src/lib/concept2-adapter.ts:266 (toIsoDate)`)
   * keys by UTC date. The wrapper must therefore translate `opts.date` to
   * the local YYYY-MM-DD (see `localDateString` in this file) before
   * calling the adapter, or the late-evening east-of-UTC case will miss
   * freshly-synced data. See ADR 0001 for the local-time convention.
   */
  readonly concept2Sync: (opts: {
    habitId: string;
    runId: string;
    date: Date;
  }) => Promise<void>;
  /**
   * Refresh the Garmin cache for the run's date. Same TZ contract as
   * `concept2Sync`: the wrapper MUST cause `sensor_signals` to be keyed
   * by the run's local `fire_date`. If the underlying adapter keys by
   * UTC (cf. `src/lib/concept2-adapter.ts:266 (toIsoDate)`), translate
   * via `localDateString` before calling the adapter. See ADR 0001.
   */
  readonly garminSync: (opts: {
    habitId: string;
    runId: string;
    date: Date;
  }) => Promise<void>;
  readonly postCompletion: (opts: {
    channelId: string;
    runId: string;
    summary: string;
  }) => Promise<void>;
}

// -----------------------------------------------------------------------------
// Internal helpers.
// -----------------------------------------------------------------------------

// YYYY-MM-DD in process local time. Matches the daemon's `fire_date`
// writer (ADR 0001: cron expressions are interpreted in local time).
// Inlined here rather than imported from `discord-adapter.ts` because the
// helper is private to four other modules already (bootstrap.ts,
// discord-adapter.ts, evaluate-stage-b.ts, habit-checkin.ts); centralising
// would be a separate refactor. See task report for rationale.
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface PendingRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
  readonly channel_id: string;
  readonly proof_type: string;
  readonly proof_config_json: string;
}

interface SensorPayloadRow {
  readonly payload_json: string;
}

interface Concept2Payload {
  readonly results: readonly Concept2Result[];
}

interface MorningRowProofConfig {
  readonly min_minutes: number;
}

function loadPendingRuns(
  db: Database.Database,
  today: string,
): readonly PendingRunRow[] {
  return db
    .prepare(
      `SELECT r.id           AS id,
              r.habit_id     AS habit_id,
              r.fire_date    AS fire_date,
              h.channel_id   AS channel_id,
              h.proof_type   AS proof_type,
              h.proof_config_json AS proof_config_json
         FROM habit_runs r
         JOIN habits h ON h.id = r.habit_id
        WHERE r.status = 'pending'
          AND r.fire_date = ?`,
    )
    .all(today) as readonly PendingRunRow[];
}

function loadCachedConcept2Results(
  db: Database.Database,
  fireDate: string,
): readonly Concept2Result[] {
  const row = db
    .prepare(
      `SELECT payload_json
         FROM sensor_signals
        WHERE source = 'concept2' AND payload_date = ?`,
    )
    .get(fireDate) as SensorPayloadRow | undefined;
  if (row === undefined) {
    return [];
  }
  const parsed = JSON.parse(row.payload_json) as Concept2Payload;
  return parsed.results;
}

function parseMorningRowConfig(json: string): MorningRowProofConfig {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const minMinutes = parsed.min_minutes;
  if (typeof minMinutes !== "number") {
    throw new Error(
      "morning-row proof_config_json missing numeric min_minutes",
    );
  }
  return { min_minutes: minMinutes };
}

/**
 * Compose a `✓` ack line for #wins + source channel.
 *
 * Example: `✓ Morning row · 2026-05-13 09:35:00 · 10:03 · 2279m`.
 */
function formatMorningRowSummary(session: Concept2Result): string {
  const totalSeconds = Math.floor(session.duration_seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `✓ Morning row · ${session.date} · ${mmss} · ${session.distance_meters}m`;
}

interface CompletionWriteContext {
  readonly db: Database.Database;
  readonly sessionStore: SessionStore;
  readonly now: number;
  readonly habitId: string;
  readonly runId: string;
  readonly proofPayload: unknown;
}

/**
 * Single transaction: flip habit_runs.status to 'completed' AND append the
 * audit-trail `habit_completed` session event. The session id is the
 * synthetic `"reconcile"` value — `SessionStore.append` will lazily
 * create the session row if it doesn't yet exist.
 */
function writeCompletion(ctx: CompletionWriteContext): void {
  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE habit_runs
            SET status = 'completed',
                completed_at = ?,
                next_escalation_at = NULL,
                proof_payload_json = ?
          WHERE id = ?`,
      )
      .run(ctx.now, JSON.stringify({ proof: ctx.proofPayload }), ctx.runId);

    ctx.sessionStore.append(
      "reconcile",
      "habit_completed",
      {
        habitId: ctx.habitId,
        runId: ctx.runId,
        completedAt: ctx.now,
        proofPayload: ctx.proofPayload,
      },
      { trustLevel: "L1" },
    );
  });
  tx();
}

// -----------------------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------------------

export async function reconcilePendingRuns(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const db = opts.sessionStore.db;
  const today = localDateString(new Date(opts.now));

  const pending = loadPendingRuns(db, today);

  let attempted = 0;
  let completed = 0;

  for (const row of pending) {
    // Phase 1.2 handles only Concept2-backed morning-row runs. Other
    // proof types fall through to 1.3+ wiring; for now they remain
    // pending and the reconciler is a no-op for them.
    if (row.proof_type !== "concept2_api+photo_fallback") {
      continue;
    }

    attempted += 1;

    // Refresh the Concept2 cache. The injected sync function is async and
    // may throw; per design § 4 + Task 15, sync failures should surface so
    // the daemon's sensor-failure path can be wired in Task 1.4+. For the
    // skeleton-plus-Concept2 milestone we let the error propagate.
    await opts.concept2Sync({
      habitId: row.habit_id,
      runId: row.id,
      date: new Date(opts.now),
    });

    // Read the (just-refreshed) cached payload. `fire_date` is the
    // canonical local-date key for both habit_runs and sensor_signals.
    const results = loadCachedConcept2Results(db, row.fire_date);
    const config = parseMorningRowConfig(row.proof_config_json);
    const matched = findQualifyingSession(results, config.min_minutes);

    if (matched === undefined) {
      continue;
    }

    const proofPayload = {
      source: "concept2" as const,
      session: matched,
      autoDetected: true,
    };

    writeCompletion({
      db,
      sessionStore: opts.sessionStore,
      now: opts.now,
      habitId: row.habit_id,
      runId: row.id,
      proofPayload,
    });

    const summary = formatMorningRowSummary(matched);

    // Post to the source channel (resolved by production wrapper from
    // habits.channel_id — a Discord snowflake) AND to #wins (a channel
    // name keyword resolved by the wrapper via adapter.channelIds.wins).
    // The asymmetry is intentional and is unified by the Task 1.5 wiring.
    //
    // The DB write above is irreversible (status is already 'completed').
    // Each post failure is logged to stderr but MUST NOT abort the batch
    // or prevent the sibling post — otherwise a flaky channel could leave
    // the user without an ack AND block reconciliation of remaining rows.
    // Pattern mirrors `verify-proof.ts:670-682` (Stage-A wind-down ack).
    try {
      await opts.postCompletion({
        channelId: row.channel_id,
        runId: row.id,
        summary,
      });
    } catch (err: unknown) {
      console.error(
        `[reconcile-pending-runs] source-channel ack post failed for run ${row.id}`,
        err,
      );
    }
    try {
      await opts.postCompletion({
        channelId: "wins",
        runId: row.id,
        summary,
      });
    } catch (err: unknown) {
      console.error(
        `[reconcile-pending-runs] wins ack post failed for run ${row.id}`,
        err,
      );
    }

    completed += 1;
  }

  return {
    attempted,
    completed,
    stillPending: attempted - completed,
  };
}
