// Task 37: evaluate-stage-b verb + 9am cron.
//
// Runs once per day (cron `0 9 * * *`) to resolve wind-down runs that are
// stuck in status='partial' after the user typed "shutting down" the prior
// evening (stage A — handled by Task 36). The verb pulls last night's Garmin
// `sleep_onset_time` and decides:
//
//   - onset HH:MM <= proof_config.stage_b_threshold (e.g. "23:00") → completed
//   - onset HH:MM >  proof_config.stage_b_threshold              → missed
//   - no Garmin signal OR sleep:null                             → noData
//
// On `completed`:
//   - INSERT a stage='b' proof_stages row (deterministic id `proof-{runId}-b`).
//   - UPDATE habit_runs SET status='completed', completed_at=now.
//   - Append a typed `habit_completed` session_event at trust level L1
//     (sensor-attested but not human-attested in real-time).
//   - Post the canonical row to #wins via the Task 23 wins-poster.
//
// On `missed`:
//   - UPDATE habit_runs SET status='missed'.
//   - Append a typed `habit_missed` session_event at trust level L1.
//   - INSERT a miss_reasons row (deterministic id `miss-{runId}`) carrying
//     gap_metadata_json with `{stage_a_time, stage_b_actual_onset, gap_minutes}`.
//     `user_response_text` and `classification` are left NULL — the post-miss
//     interview classifier (Phase B) fills those in once the user replies.
//   - Post the curious follow-up question to #wind-down per design § 4.
//
// On `noData`: leave status='partial'. The Task 16 retry-unresolved-sensors
// cron does NOT pick partial runs back up (it scans status='unresolved'),
// but a future Task may add a similar "retry stage B" path. For now,
// partial runs without sensor data simply sit until the user gets a fresh
// Garmin sync. The 48h aging rule from Task 16 has no analogue here yet.
//
// Single-writer invariant: all writes go through `sessionStore.db` so the
// habit_runs / proof_stages / miss_reasons / session_events updates share
// one SQLite connection. The Discord posts (wins + follow-up) happen
// AFTER the DB transaction commits — if a Discord call throws, the state
// transition is already durably written. The verb still propagates the
// throw so the caller can decide retry/back-off policy.
//
// Dependency injection (test seam):
//   - `postImpl` mirrors the Task 36 stage-A ack pattern: production
//     callers leave it unset and get the real `postToChannel`.
//   - `winsPostImpl` lets tests skip the `postToChannel` round-trip via
//     `wins-poster.postWin`. Production callers pass the real `postWin`.
//
// Cron registration: `registerEvaluateStageBCron()` inserts a single row
// into `schedules` with cron='0 9 * * *', verb='evaluate-stage-b',
// missed_run_policy='skip', dispatch_priority=10 (highest in Phase A — the
// 9am wins/follow-up post must precede any habit prompts scheduled for the
// same minute). The function is idempotent via a SELECT-first guard,
// matching the Task 16 cron registration pattern.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 37
//   - docs/plans/2026-05-12-habit-daemon-design.md § 4 (post-miss interview)
//   - src/orchestrate/wins-poster.ts (Task 23 — postWin / WindDownCompletion)
//   - src/orchestrate/retry-unresolved-sensors.ts (Task 16 — cron precedent)

import type Database from "better-sqlite3";
import type { SessionStore } from "../daemon/session-store.js";
import {
  postToChannel,
  type ChannelName,
  type DiscordAdapter,
  type PostResult,
} from "../lib/discord-adapter.js";
import {
  postWin,
  type WindDownCompletion,
} from "./wins-poster.js";
import { formatWindDownSummary } from "./reconcile-pending-runs.js";
import { localDateString } from "../lib/local-date.js";

// -----------------------------------------------------------------------------
// Public API.
// -----------------------------------------------------------------------------

export interface EvaluateStageBOptions {
  readonly sessionStore: SessionStore;
  readonly adapter: DiscordAdapter;
  readonly sessionId: string;
  readonly now: number;
  /** Test seam: overrides #wind-down follow-up post. */
  readonly postImpl?: (opts: {
    adapter: DiscordAdapter;
    channel: "wind-down";
    content: string;
  }) => Promise<PostResult>;
  /** Test seam: overrides #wins post. */
  readonly winsPostImpl?: (opts: {
    adapter: DiscordAdapter;
    status: "completed";
    completion: WindDownCompletion;
  }) => Promise<{ readonly posted: boolean; readonly messageId?: string }>;
  /**
   * Test seam: overrides the dual-channel ack post used by the
   * pending-autonomous completion path (Task 4.1). Production callers leave
   * it unset and get a direct `postToChannel` call. The channel parameter is
   * the wider `ChannelName | string` because this seam fires for BOTH the
   * source habit channel ("wind-down") and #wins.
   */
  readonly pendingAckPostImpl?: (opts: {
    adapter: DiscordAdapter;
    channel: ChannelName | string;
    content: string;
  }) => Promise<PostResult>;
}

export interface EvaluateStageBResult {
  readonly attempted: number;
  readonly completed: number;
  readonly missed: number;
  readonly noData: number;
  /**
   * Pending wind-down rows that had a Garmin onset AFTER the threshold —
   * the verb deliberately leaves these in `status='pending'` so the user
   * may still type "shutting down" later. Mirrors the reconciler's
   * `stillPending` counter.
   */
  readonly stillPending: number;
}

// -----------------------------------------------------------------------------
// Internal types.
// -----------------------------------------------------------------------------

interface PartialRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
}

interface ProofConfigJsonRow {
  readonly proof_config_json: string;
}

interface ProofStageARow {
  readonly satisfied_at: number;
}

interface SensorSignalRow {
  readonly payload_json: string;
}

interface GarminSleepPayload {
  readonly sleep: {
    readonly sleep_onset_time: string | null;
  } | null;
}

interface WindDownProofConfig {
  readonly stage_b_threshold: string;
}

// -----------------------------------------------------------------------------
// Local helpers.
// -----------------------------------------------------------------------------

/** Format an epoch ms as HH:MM in process local time. */
function localHHMM(epochMs: number): string {
  const d = new Date(epochMs);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Convert "HH:MM" to minutes-from-local-midnight. */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Decide whether a Garmin sleep onset is past the wind-down threshold.
 *
 * Naive `onset > threshold` lex compare on HH:MM strings handles same-side-of-
 * midnight cases correctly ("22:30" < "23:00", "23:30" > "23:00") but fails
 * for post-midnight bedtimes: "01:25" < "23:00" lexically, but going to sleep
 * at 1:25 AM is clearly past a 23:00 threshold. Garmin onsets in production
 * are post-midnight more often than not.
 *
 * Fix: convert to minutes-from-midnight and treat any onset before 12:00 as
 * post-midnight by adding 1440 (a full day). The wind-down window is the
 * evening-into-next-morning — no user is going to sleep at noon, so 12:00 is
 * a safe split point.
 *
 * Examples:
 *   onset="22:30", threshold="23:00" → 1350 vs 1380 → not beyond ✓
 *   onset="23:30", threshold="23:00" → 1410 vs 1380 → beyond ✓
 *   onset="01:25", threshold="23:00" → 1525 (post-midnight +1440) vs 1380 → beyond ✓
 *   onset="00:30", threshold="22:00" → 1470 vs 1320 → beyond ✓
 */
export function onsetBeyondThreshold(onset: string, threshold: string): boolean {
  const rawOnset = hhmmToMinutes(onset);
  const threshMin = hhmmToMinutes(threshold);
  const adjustedOnset = rawOnset < 12 * 60 ? rawOnset + 1440 : rawOnset;
  return adjustedOnset > threshMin;
}

/**
 * Compute minutes elapsed between stage A and stage B in HH:MM-from-midnight
 * arithmetic. If the difference is negative (e.g., stage A at 23:55 and
 * stage B onset at 00:10), add 1440 — the user crossed midnight, which is
 * not a "missed" case but if it ever surfaces we still want a positive
 * gap. Real-world Phase A: stage A is in the 22:00-22:30 window and stage B
 * onset is anywhere from 22:30 to 02:00, so midnight crossing is plausible.
 */
function computeGapMinutes(stageAHHMM: string, stageBHHMM: string): number {
  const a = hhmmToMinutes(stageAHHMM);
  const b = hhmmToMinutes(stageBHHMM);
  const raw = b - a;
  return raw < 0 ? raw + 1440 : raw;
}

/**
 * Parse the HH:MM portion out of an ISO-ish sleep_onset_time string
 * (e.g. "2026-05-12T22:30:00", with or without timezone suffix). Returns
 * undefined if the regex doesn't match.
 */
function extractHHMM(onset: string): string | undefined {
  const m = onset.match(/T(\d{2}):(\d{2})/);
  if (m === null) return undefined;
  return `${m[1]}:${m[2]}`;
}

function loadStageBThreshold(
  db: Database.Database,
  habitId: string,
): string {
  const row = db
    .prepare(`SELECT proof_config_json FROM habits WHERE id = ?`)
    .get(habitId) as ProofConfigJsonRow | undefined;
  if (row === undefined) {
    throw new Error(`habit not found: ${habitId}`);
  }
  const parsed = JSON.parse(row.proof_config_json) as Partial<WindDownProofConfig>;
  if (typeof parsed.stage_b_threshold !== "string") {
    throw new Error(
      `habit ${habitId} proof_config_json missing stage_b_threshold string`,
    );
  }
  return parsed.stage_b_threshold;
}

function loadStageASatisfiedAt(
  db: Database.Database,
  runId: string,
): number | undefined {
  const row = db
    .prepare(
      `SELECT satisfied_at FROM proof_stages
         WHERE run_id = ? AND stage = 'a' AND satisfied = 1
         LIMIT 1`,
    )
    .get(runId) as ProofStageARow | undefined;
  if (row === undefined) return undefined;
  return row.satisfied_at;
}

function loadGarminOnset(
  db: Database.Database,
  fireDate: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT payload_json FROM sensor_signals
         WHERE source = 'garmin' AND payload_date = ?
         LIMIT 1`,
    )
    .get(fireDate) as SensorSignalRow | undefined;
  if (row === undefined) return undefined;

  const payload = JSON.parse(row.payload_json) as GarminSleepPayload;
  if (payload.sleep === null || payload.sleep === undefined) return undefined;
  if (payload.sleep.sleep_onset_time === null) return undefined;

  return extractHHMM(payload.sleep.sleep_onset_time);
}

// -----------------------------------------------------------------------------
// Default Discord post implementations (production fall-through).
// -----------------------------------------------------------------------------

async function defaultWindDownPost(opts: {
  adapter: DiscordAdapter;
  channel: "wind-down";
  content: string;
}): Promise<PostResult> {
  return postToChannel({
    adapter: opts.adapter,
    channel: opts.channel,
    content: opts.content,
  });
}

async function defaultWinsPost(opts: {
  adapter: DiscordAdapter;
  status: "completed";
  completion: WindDownCompletion;
}): Promise<{ readonly posted: boolean; readonly messageId?: string }> {
  return postWin({
    adapter: opts.adapter,
    status: opts.status,
    completion: opts.completion,
  });
}

/**
 * Default dual-channel ack post for the pending-autonomous completion
 * path. Mirrors the reconciler's `postDualChannel` (source channel +
 * #wins), but the dispatch lives inline in `evaluateStageB` so each
 * post can be wrapped in its own try/catch. This default just hands
 * the call off to `postToChannel`.
 */
async function defaultPendingAckPost(opts: {
  adapter: DiscordAdapter;
  channel: ChannelName | string;
  content: string;
}): Promise<PostResult> {
  return postToChannel({
    adapter: opts.adapter,
    channel: opts.channel,
    content: opts.content,
  });
}

// -----------------------------------------------------------------------------
// Curious follow-up template (design § 4 — verbatim phrasing).
// -----------------------------------------------------------------------------

function buildFollowUpText(opts: {
  readonly stageATime: string;
  readonly stageBActual: string;
  readonly gapMinutes: number;
}): string {
  return (
    `Morning Max. Quick note before the row — you said shutting down at ` +
    `${opts.stageATime} but Garmin shows asleep at ${opts.stageBActual}. ` +
    `What happened in those ${opts.gapMinutes} minutes? No judgment, ` +
    `just want to know what we're working with.`
  );
}

// -----------------------------------------------------------------------------
// Per-row resolution paths.
// -----------------------------------------------------------------------------

interface ResolutionContext {
  readonly sessionStore: SessionStore;
  readonly sessionId: string;
  readonly now: number;
  readonly run: PartialRunRow;
  readonly stageATime: string;
}

function applyCompleted(
  ctx: ResolutionContext,
  stageBOnset: string,
): void {
  const db = ctx.sessionStore.db;
  const stageBId = `proof-${ctx.run.id}-b`;
  const stageBData = JSON.stringify({
    stage: "b",
    satisfied_at: ctx.now,
    sleep_onset_time: stageBOnset,
  });

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO proof_stages (id, run_id, stage, satisfied, satisfied_at, data_json)
         VALUES (?, ?, 'b', 1, ?, ?)`,
    ).run(stageBId, ctx.run.id, ctx.now, stageBData);

    db.prepare(
      `UPDATE habit_runs
          SET status = 'completed', completed_at = ?, next_escalation_at = NULL
        WHERE id = ?`,
    ).run(ctx.now, ctx.run.id);

    ctx.sessionStore.append(
      ctx.sessionId,
      "habit_completed",
      {
        habitId: ctx.run.habit_id,
        runId: ctx.run.id,
        stage_a_time: ctx.stageATime,
        stage_b_onset_time: stageBOnset,
      },
      { trustLevel: "L1" },
    );
  });
  tx();
}

function applyMissed(
  ctx: ResolutionContext,
  stageBOnset: string,
  gapMinutes: number,
): void {
  const db = ctx.sessionStore.db;
  const missId = `miss-${ctx.run.id}`;
  const gapMeta = JSON.stringify({
    stage_a_time: ctx.stageATime,
    stage_b_actual_onset: stageBOnset,
    gap_minutes: gapMinutes,
  });

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE habit_runs
          SET status = 'missed', next_escalation_at = NULL
        WHERE id = ?`,
    ).run(ctx.run.id);

    db.prepare(
      `INSERT INTO miss_reasons (
         id, habit_id, run_id, miss_date,
         user_response_text, classification,
         inferred_specifics, key_entities_json,
         classification_confidence, gap_metadata_json, created_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      missId,
      ctx.run.habit_id,
      ctx.run.id,
      ctx.run.fire_date,
      gapMeta,
      ctx.now,
    );

    ctx.sessionStore.append(
      ctx.sessionId,
      "habit_missed",
      {
        habitId: ctx.run.habit_id,
        runId: ctx.run.id,
        stage_a_time: ctx.stageATime,
        stage_b_actual_onset: stageBOnset,
        gap_minutes: gapMinutes,
      },
      { trustLevel: "L1" },
    );
  });
  tx();
}

/**
 * Task 4.1: complete a pending wind-down run autonomously from Garmin
 * alone. The user never typed "shutting down" (no stage A row in
 * proof_stages), but the sleep onset is at-or-before the threshold —
 * the desired behaviour fired even though the verbal commitment didn't.
 *
 * Writes are bundled into one transaction:
 *   - INSERT a stage='b' proof_stages row with `autoDetected:true` in
 *     `data_json` so the audit trail records that this completion was
 *     decided without a typed-msg stage A.
 *   - UPDATE habit_runs to status='completed', clear `next_escalation_at`,
 *     and persist a Garmin-shaped proof_payload_json matching the
 *     reconciler's payload shape (source, sleep_onset, autoDetected).
 *   - Append a `habit_completed` session event at L1 trust carrying
 *     `autoDetected:true`.
 *
 * Discord posts (source channel + #wins) happen AFTER the transaction
 * commits — caller dispatches via the optional `pendingAckPostImpl`
 * seam. We do NOT post via `wins-poster.postWin` here because that path
 * requires a typed `WindDownCompletion.stageATime` and we don't have a
 * stage A timestamp in the pending-autonomous case.
 */
interface PendingAutonomousContext {
  readonly sessionStore: SessionStore;
  readonly sessionId: string;
  readonly now: number;
  readonly run: PartialRunRow;
}

function applyPendingCompletedFromGarmin(
  ctx: PendingAutonomousContext,
  onset: string,
): void {
  const db = ctx.sessionStore.db;
  const stageBId = `proof-${ctx.run.id}-b`;
  const stageBData = JSON.stringify({
    stage: "b",
    satisfied_at: ctx.now,
    sleep_onset_time: onset,
    autoDetected: true,
  });
  const proofPayloadJson = JSON.stringify({
    proof: {
      source: "garmin",
      sleep_onset: onset,
      autoDetected: true,
    },
  });

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO proof_stages (id, run_id, stage, satisfied, satisfied_at, data_json)
         VALUES (?, ?, 'b', 1, ?, ?)`,
    ).run(stageBId, ctx.run.id, ctx.now, stageBData);

    db.prepare(
      `UPDATE habit_runs
          SET status = 'completed',
              completed_at = ?,
              next_escalation_at = NULL,
              proof_payload_json = ?
        WHERE id = ?`,
    ).run(ctx.now, proofPayloadJson, ctx.run.id);

    ctx.sessionStore.append(
      ctx.sessionId,
      "habit_completed",
      {
        habitId: ctx.run.habit_id,
        runId: ctx.run.id,
        stage_b_onset_time: onset,
        autoDetected: true,
      },
      { trustLevel: "L1" },
    );
  });
  tx();
}

// -----------------------------------------------------------------------------
// Verb entry point.
// -----------------------------------------------------------------------------

export async function evaluateStageB(
  opts: EvaluateStageBOptions,
): Promise<EvaluateStageBResult> {
  const db = opts.sessionStore.db;
  const post = opts.postImpl ?? defaultWindDownPost;
  const wins = opts.winsPostImpl ?? defaultWinsPost;
  const pendingAck = opts.pendingAckPostImpl ?? defaultPendingAckPost;

  const yesterday = localDateString(opts.now - 24 * 3_600_000);
  const threshold = loadStageBThreshold(db, "wind-down");

  // Task 4.1: loosened to include `pending` rows so the verb can complete
  // wind-down runs autonomously from Garmin even when the user never typed
  // "shutting down". The reconciler does the same on its 2-minute cron; this
  // is intentional redundancy — both verbs converge on the same idempotent
  // SQL filter.
  const rows = db
    .prepare(
      `SELECT id, habit_id, fire_date FROM habit_runs
         WHERE habit_id = 'wind-down'
           AND status IN ('pending','partial')
           AND fire_date = ?
         ORDER BY fired_at ASC`,
    )
    .all(yesterday) as readonly PartialRunRow[];

  let attempted = 0;
  let completed = 0;
  let missed = 0;
  let noData = 0;
  let stillPending = 0;

  for (const run of rows) {
    attempted += 1;

    const onset = loadGarminOnset(db, run.fire_date);
    if (onset === undefined) {
      noData += 1;
      continue;
    }

    const stageAEpoch = loadStageASatisfiedAt(db, run.id);

    if (stageAEpoch === undefined) {
      // Pending path (Task 4.1): no stage A row → decide on Garmin alone.
      // Onset > threshold leaves the row pending (the user may still type
      // "shutting down" later; the miss-transition lives in the partial
      // path after stage A lands). Onset ≤ threshold autonomously completes.
      if (onsetBeyondThreshold(onset, threshold)) {
        stillPending += 1;
        continue;
      }

      applyPendingCompletedFromGarmin(
        {
          sessionStore: opts.sessionStore,
          sessionId: opts.sessionId,
          now: opts.now,
          run,
        },
        onset,
      );
      completed += 1;

      // Dual-channel ack: source channel + #wins. Each post is wrapped in
      // its own try/catch — the DB write is already committed and a flaky
      // channel must not prevent the sibling post or abort the batch.
      // Mirrors `reconcile-pending-runs.ts:postDualChannel`.
      const summary = formatWindDownSummary(onset, threshold);
      try {
        await pendingAck({
          adapter: opts.adapter,
          channel: "wind-down",
          content: summary,
        });
      } catch (err: unknown) {
        console.error(
          `[evaluate-stage-b] source-channel ack post failed for run ${run.id}`,
          err,
        );
      }
      try {
        await pendingAck({
          adapter: opts.adapter,
          channel: "wins",
          content: summary,
        });
      } catch (err: unknown) {
        console.error(
          `[evaluate-stage-b] wins ack post failed for run ${run.id}`,
          err,
        );
      }
      continue;
    }

    // Partial path (unchanged): stage A row present → use the existing
    // applyCompleted / applyMissed helpers with stage A timing.
    const stageATime = localHHMM(stageAEpoch);

    // onsetBeyondThreshold handles post-midnight bedtimes correctly — naive
    // lex compare on HH:MM treats "01:25" < "23:00" as true, but 1:25 AM is
    // past a 23:00 threshold.
    if (!onsetBeyondThreshold(onset, threshold)) {
      const ctx: ResolutionContext = {
        sessionStore: opts.sessionStore,
        sessionId: opts.sessionId,
        now: opts.now,
        run,
        stageATime,
      };
      applyCompleted(ctx, onset);
      completed += 1;

      // #wins post happens after the DB transaction commits.
      await wins({
        adapter: opts.adapter,
        status: "completed",
        completion: {
          habit: "wind-down",
          stageATime,
          garminAsleepTime: onset,
        },
      });
    } else {
      const gapMinutes = computeGapMinutes(stageATime, onset);
      const ctx: ResolutionContext = {
        sessionStore: opts.sessionStore,
        sessionId: opts.sessionId,
        now: opts.now,
        run,
        stageATime,
      };
      applyMissed(ctx, onset, gapMinutes);
      missed += 1;

      // Curious follow-up to #wind-down after the DB transaction commits.
      await post({
        adapter: opts.adapter,
        channel: "wind-down",
        content: buildFollowUpText({
          stageATime,
          stageBActual: onset,
          gapMinutes,
        }),
      });
    }
  }

  return { attempted, completed, missed, noData, stillPending };
}

// -----------------------------------------------------------------------------
// Cron registration.
// -----------------------------------------------------------------------------

/**
 * Register the daily 9am cron that invokes `evaluate-stage-b`. Idempotent:
 * a SELECT-first guard skips the INSERT when a row with the same verb
 * already exists. Matches the Task 16 cron registration pattern (the
 * `schedules` table has no UNIQUE(verb) constraint in Phase A).
 *
 * `dispatch_priority=10` is the highest priority in Phase A — the 9am
 * wins/follow-up post must fire before any 9:05am `morning-row` prompt that
 * could land in the same scheduler tick (the design's "wind-down precedence
 * over morning-row" rule).
 */
export function registerEvaluateStageBCron(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT id FROM schedules WHERE verb = ?`)
    .get("evaluate-stage-b");
  if (existing !== undefined) {
    return;
  }

  db.prepare(
    `INSERT INTO schedules (
       cron_expr, verb, args_json, missed_run_policy, enabled, dispatch_priority
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("0 9 * * *", "evaluate-stage-b", "{}", "skip", 1, 10);
}
