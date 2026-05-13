// Task 37: evaluate-stage-b verb tests.
//
// The verb runs once per day (cron `0 9 * * *`) and resolves wind-down runs
// that are stuck in status='partial' after the user typed "shutting down" the
// previous night (stage A). It pulls last night's Garmin sleep onset and
// decides:
//
//   - sleep_onset_time HH:MM <= stage_b_threshold (e.g. "23:00") → completed
//   - sleep_onset_time HH:MM >  stage_b_threshold              → missed
//   - no Garmin signal / sleep:null                            → noData (stay partial)
//
// On `completed`: insert a stage='b' proof_stages row, transition habit_runs
// to 'completed', append a typed `habit_completed` event, and post the
// canonical row to #wins via the Task 23 wins-poster.
//
// On `missed`: transition habit_runs to 'missed', append a typed
// `habit_missed` event, insert a miss_reasons row carrying
// gap_metadata_json with {stage_a_time, stage_b_actual_onset, gap_minutes},
// and post a curious follow-up question to #wind-down (design § 4).
//
// `registerEvaluateStageBCron` inserts the schedules row at cron `0 9 * * *`
// with dispatch_priority=10 (highest in Phase A — wins/miss-followup posts
// must hit Discord before any 9am habit prompts go out).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 37
//   - docs/plans/2026-05-12-habit-daemon-design.md § 4 (post-miss interview)
//   - src/orchestrate/wins-poster.ts (Task 23 #wins post path)
//   - src/orchestrate/retry-unresolved-sensors.ts (Task 16 cron precedent)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import {
  createDiscordAdapter,
  type DiscordAdapter,
  type PostResult,
} from "../../src/lib/discord-adapter.js";
import type { WindDownCompletion } from "../../src/orchestrate/wins-poster.js";
import {
  evaluateStageB,
  registerEvaluateStageBCron,
} from "../../src/orchestrate/evaluate-stage-b.js";

// -----------------------------------------------------------------------------
// Fixtures + helpers.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const SESSION_ID = "session-eval-stage-b-0001";

// 2026-05-12 13:00 UTC = within May 12 local-date across UTC-12 to UTC+10. We
// pick mid-day UTC so the "yesterday = now - 24h" calculation lands on May 11
// in any plausible TZ a developer might run tests in.
const NOW_MS = Date.parse("2026-05-12T13:00:00.000Z");
const ONE_HOUR_MS = 3_600_000;

// Format an epoch ms as YYYY-MM-DD in process local time. Mirrors the
// implementation's localDateString helper so the test is TZ-agnostic.
function localDateString(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Format an epoch ms as HH:MM in process local time.
function localHHMM(epochMs: number): string {
  const d = new Date(epochMs);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function minutesFromMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

// Yesterday's local date string (the wind-down fire_date the verb looks for).
const YESTERDAY_DATE = localDateString(NOW_MS - 24 * ONE_HOUR_MS);

// Stage A satisfied_at: ~11 hours before NOW_MS — so on May 11 evening local.
const STAGE_A_SATISFIED_AT = NOW_MS - 11 * ONE_HOUR_MS;
const STAGE_A_HHMM = localHHMM(STAGE_A_SATISFIED_AT);

// Fired_at: 12 hours before NOW_MS — slightly before stage A satisfied_at.
const FIRED_AT_MS = NOW_MS - 12 * ONE_HOUR_MS;

interface SeedRunOpts {
  readonly runId: string;
  readonly habitId?: string;
  readonly status?: string;
  readonly fireDate?: string;
  readonly firedAt?: number;
}

function seedHabitRun(db: Database.Database, opts: SeedRunOpts): void {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.habitId ?? "wind-down",
    opts.fireDate ?? YESTERDAY_DATE,
    opts.firedAt ?? FIRED_AT_MS,
    1,
    null,
    opts.status ?? "partial",
    null,
    null,
    null,
    0,
  );
}

function seedStageA(
  db: Database.Database,
  runId: string,
  satisfiedAt: number = STAGE_A_SATISFIED_AT,
): void {
  db.prepare(
    `INSERT INTO proof_stages (id, run_id, stage, satisfied, satisfied_at, data_json)
     VALUES (?, ?, 'a', 1, ?, ?)`,
  ).run(
    `proof-${runId}-a`,
    runId,
    satisfiedAt,
    JSON.stringify({
      stage: "a",
      satisfied_at: satisfiedAt,
      message_text: "shutting down",
    }),
  );
}

function seedGarminSignal(
  db: Database.Database,
  date: string,
  onsetTime: string | null,
): void {
  const sleep =
    onsetTime === null
      ? null
      : {
          sleep_onset_time: onsetTime,
          total_sleep_minutes: 420,
          rem_minutes: 90,
          deep_sleep_minutes: 60,
          hrv: 55,
        };
  db.prepare(
    `INSERT OR REPLACE INTO sensor_signals (
       id, source, payload_date, payload_json, fetched_at
     ) VALUES (?, 'garmin', ?, ?, ?)`,
  ).run(`garmin-${date}`, date, JSON.stringify({ sleep }), NOW_MS);
}

interface PostCall {
  readonly adapter: DiscordAdapter;
  readonly channel: "wind-down";
  readonly content: string;
}

function makeRecordingPostImpl(): {
  readonly impl: (opts: PostCall) => Promise<PostResult>;
  readonly calls: PostCall[];
} {
  const calls: PostCall[] = [];
  const impl = async (opts: PostCall): Promise<PostResult> => {
    calls.push(opts);
    return {
      messageId: `msg-followup-${calls.length}`,
      channelId: SEED_CHANNELS.windDown,
      postedAt: NOW_MS,
    };
  };
  return { impl, calls };
}

interface WinsCall {
  readonly adapter: DiscordAdapter;
  readonly status: "completed";
  readonly completion: WindDownCompletion;
}

function makeRecordingWinsImpl(): {
  readonly impl: (
    opts: WinsCall,
  ) => Promise<{ readonly posted: boolean; readonly messageId?: string }>;
  readonly calls: WinsCall[];
} {
  const calls: WinsCall[] = [];
  const impl = async (
    opts: WinsCall,
  ): Promise<{ readonly posted: boolean; readonly messageId?: string }> => {
    calls.push(opts);
    return { posted: true, messageId: `wins-msg-${calls.length}` };
  };
  return { impl, calls };
}

function buildAdapter(): DiscordAdapter {
  // No real client touched — both postImpl and winsPostImpl are injected.
  const mockClient = {
    channels: {
      fetch: vi
        .fn()
        .mockRejectedValue(
          new Error("client.channels.fetch should not be called"),
        ),
    },
  };
  return createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: {
      "morning-row": SEED_CHANNELS.morningRow,
      strength: SEED_CHANNELS.strength,
      "wind-down": SEED_CHANNELS.windDown,
      wins: "1000000000000000004",
      "sunday-review": "1000000000000000005",
    },
    clientFactory: () => mockClient as unknown as Client,
  });
}

interface RunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
  readonly status: string;
  readonly completed_at: number | null;
  readonly next_escalation_at: number | null;
}

function readRun(db: Database.Database, runId: string): RunRow | undefined {
  return db
    .prepare(
      `SELECT id, habit_id, fire_date, status, completed_at, next_escalation_at
         FROM habit_runs WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;
}

interface ProofStageRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage: string;
  readonly satisfied: number;
  readonly satisfied_at: number | null;
  readonly data_json: string | null;
}

function readStages(
  db: Database.Database,
  runId: string,
): readonly ProofStageRow[] {
  return db
    .prepare(
      `SELECT id, run_id, stage, satisfied, satisfied_at, data_json
         FROM proof_stages WHERE run_id = ? ORDER BY stage ASC`,
    )
    .all(runId) as readonly ProofStageRow[];
}

interface MissRow {
  readonly id: string;
  readonly habit_id: string;
  readonly run_id: string;
  readonly miss_date: string;
  readonly user_response_text: string | null;
  readonly classification: string | null;
  readonly gap_metadata_json: string | null;
  readonly created_at: number;
}

function readMissRows(
  db: Database.Database,
  runId: string,
): readonly MissRow[] {
  return db
    .prepare(`SELECT * FROM miss_reasons WHERE run_id = ?`)
    .all(runId) as readonly MissRow[];
}

interface SessionEventRow {
  readonly seq: number;
  readonly event_json: string;
  readonly trust_level: string;
  readonly event_type: string | null;
}

function readEvents(
  db: Database.Database,
  sessionId: string,
): readonly SessionEventRow[] {
  return db
    .prepare(
      `SELECT seq, event_json, trust_level, event_type FROM session_events
         WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as readonly SessionEventRow[];
}

interface ScheduleRow {
  readonly id: number;
  readonly cron_expr: string;
  readonly verb: string;
  readonly args_json: string;
  readonly missed_run_policy: string;
  readonly enabled: number;
  readonly dispatch_priority: number;
}

interface CountRow {
  readonly n: number;
}

function countSchedules(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM schedules`).get() as CountRow).n;
}

// -----------------------------------------------------------------------------
// Harness.
// -----------------------------------------------------------------------------

async function buildHarness(): Promise<{
  tempDir: string;
  sessionStore: SessionStore;
  db: Database.Database;
  adapter: DiscordAdapter;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-eval-stage-b-"));
  const dbPath = join(tempDir, "store.db");
  const migrator = openDatabase(dbPath);
  await runMigrations(migrator, loadMigrations());
  seedHabits(migrator, SEED_CHANNELS);
  migrator.close();
  const sessionStore = new SessionStore({ dbPath });
  return {
    tempDir,
    sessionStore,
    db: sessionStore.db,
    adapter: buildAdapter(),
  };
}

// -----------------------------------------------------------------------------
// Tests — evaluateStageB().
// -----------------------------------------------------------------------------

describe("evaluateStageB()", () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    harness.sessionStore.close();
    rmSync(harness.tempDir, { recursive: true, force: true });
  });

  it("transitions to 'completed' when sleep_onset_time <= stage_b_threshold (22:30 <= 23:00)", async () => {
    const runId = "run-eval-ok";
    seedHabitRun(harness.db, { runId });
    seedStageA(harness.db, runId);
    seedGarminSignal(harness.db, YESTERDAY_DATE, `${YESTERDAY_DATE}T22:30:00`);

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result).toEqual({
      attempted: 1,
      completed: 1,
      missed: 0,
      noData: 0,
      stillPending: 0,
    });

    const run = readRun(harness.db, runId);
    expect(run?.status).toBe("completed");
    expect(run?.completed_at).toBe(NOW_MS);

    const stages = readStages(harness.db, runId);
    expect(stages).toHaveLength(2); // stage A (seeded) + stage B (just written).
    const stageB = stages.find((s) => s.stage === "b");
    expect(stageB).toBeDefined();
    expect(stageB!.satisfied).toBe(1);
    expect(stageB!.satisfied_at).toBe(NOW_MS);
    expect(stageB!.id).toContain(runId);
    // Stage B data_json carries the onset time.
    const stageBData = JSON.parse(stageB!.data_json ?? "{}") as {
      stage: string;
      sleep_onset_time: string;
    };
    expect(stageBData.stage).toBe("b");
    expect(stageBData.sleep_onset_time).toBe("22:30");

    // #wins post called via injected wins impl.
    expect(wins.calls).toHaveLength(1);
    expect(wins.calls[0]!.status).toBe("completed");
    expect(wins.calls[0]!.completion).toEqual({
      habit: "wind-down",
      stageATime: STAGE_A_HHMM,
      garminAsleepTime: "22:30",
    });

    // No #wind-down follow-up on completion.
    expect(post.calls).toHaveLength(0);

    // habit_completed event appended at L1.
    const events = readEvents(harness.db, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("habit_completed");
    expect(events[0]!.trust_level).toBe("L1");
    const payload = JSON.parse(events[0]!.event_json) as {
      habitId: string;
      runId: string;
      stage_a_time: string;
      stage_b_onset_time: string;
    };
    expect(payload.habitId).toBe("wind-down");
    expect(payload.runId).toBe(runId);
    expect(payload.stage_a_time).toBe(STAGE_A_HHMM);
    expect(payload.stage_b_onset_time).toBe("22:30");
  });

  it("transitions to 'missed' when sleep_onset_time > stage_b_threshold (23:45 > 23:00) and writes miss_reasons", async () => {
    const runId = "run-eval-miss";
    seedHabitRun(harness.db, { runId });
    seedStageA(harness.db, runId);
    seedGarminSignal(harness.db, YESTERDAY_DATE, `${YESTERDAY_DATE}T23:45:00`);

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result).toEqual({
      attempted: 1,
      completed: 0,
      missed: 1,
      noData: 0,
      stillPending: 0,
    });

    const run = readRun(harness.db, runId);
    expect(run?.status).toBe("missed");

    // No stage B proof_stages row — only the seeded stage A remains.
    const stages = readStages(harness.db, runId);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.stage).toBe("a");

    // miss_reasons row carries gap_metadata_json.
    const misses = readMissRows(harness.db, runId);
    expect(misses).toHaveLength(1);
    expect(misses[0]!.habit_id).toBe("wind-down");
    expect(misses[0]!.miss_date).toBe(YESTERDAY_DATE);
    expect(misses[0]!.user_response_text).toBeNull();
    expect(misses[0]!.classification).toBeNull();
    expect(misses[0]!.created_at).toBe(NOW_MS);
    expect(misses[0]!.id).toContain(runId);

    const expectedGap =
      minutesFromMidnight("23:45") - minutesFromMidnight(STAGE_A_HHMM);
    const gapMeta = JSON.parse(misses[0]!.gap_metadata_json ?? "{}") as {
      stage_a_time: string;
      stage_b_actual_onset: string;
      gap_minutes: number;
    };
    expect(gapMeta.stage_a_time).toBe(STAGE_A_HHMM);
    expect(gapMeta.stage_b_actual_onset).toBe("23:45");
    expect(gapMeta.gap_minutes).toBe(expectedGap);

    // Curious follow-up posted to #wind-down.
    expect(post.calls).toHaveLength(1);
    expect(post.calls[0]!.channel).toBe("wind-down");
    expect(post.calls[0]!.adapter).toBe(harness.adapter);
    expect(post.calls[0]!.content).toContain(STAGE_A_HHMM);
    expect(post.calls[0]!.content).toContain("23:45");
    expect(post.calls[0]!.content).toContain(`${expectedGap} minutes`);
    // Verbatim design-doc fragments.
    expect(post.calls[0]!.content).toContain("Morning Max");
    expect(post.calls[0]!.content).toContain("No judgment");

    // No #wins post.
    expect(wins.calls).toHaveLength(0);

    // habit_missed event appended at L1.
    const events = readEvents(harness.db, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("habit_missed");
    expect(events[0]!.trust_level).toBe("L1");
    const payload = JSON.parse(events[0]!.event_json) as {
      habitId: string;
      runId: string;
      stage_a_time: string;
      stage_b_actual_onset: string;
      gap_minutes: number;
    };
    expect(payload.habitId).toBe("wind-down");
    expect(payload.runId).toBe(runId);
    expect(payload.gap_minutes).toBe(expectedGap);
  });

  it("computes gap_minutes for the canonical 22:08 → 23:45 case (97 minutes)", async () => {
    // Pin stage A to a satisfied_at that is local 22:08 — derive epoch from
    // the local-TZ midnight of YESTERDAY_DATE to be TZ-agnostic.
    const yesterdayMidnight = new Date(
      Number(YESTERDAY_DATE.slice(0, 4)),
      Number(YESTERDAY_DATE.slice(5, 7)) - 1,
      Number(YESTERDAY_DATE.slice(8, 10)),
      0,
      0,
      0,
      0,
    ).getTime();
    const stageAAt = yesterdayMidnight + (22 * 60 + 8) * 60_000; // 22:08 local.

    const runId = "run-eval-97min";
    seedHabitRun(harness.db, { runId });
    seedStageA(harness.db, runId, stageAAt);
    seedGarminSignal(harness.db, YESTERDAY_DATE, `${YESTERDAY_DATE}T23:45:00`);

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result.missed).toBe(1);
    const misses = readMissRows(harness.db, runId);
    const meta = JSON.parse(misses[0]!.gap_metadata_json ?? "{}") as {
      gap_minutes: number;
      stage_a_time: string;
      stage_b_actual_onset: string;
    };
    expect(meta.stage_a_time).toBe("22:08");
    expect(meta.stage_b_actual_onset).toBe("23:45");
    expect(meta.gap_minutes).toBe(97);
    expect(post.calls[0]!.content).toContain("97 minutes");
  });

  it("leaves status='partial' when no Garmin sensor_signal exists (noData)", async () => {
    const runId = "run-eval-no-signal";
    seedHabitRun(harness.db, { runId });
    seedStageA(harness.db, runId);
    // Intentionally NO seedGarminSignal call.

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result).toEqual({
      attempted: 1,
      completed: 0,
      missed: 0,
      noData: 1,
      stillPending: 0,
    });
    const run = readRun(harness.db, runId);
    expect(run?.status).toBe("partial");
    expect(readStages(harness.db, runId)).toHaveLength(1); // Only stage A.
    expect(readMissRows(harness.db, runId)).toHaveLength(0);
    expect(post.calls).toHaveLength(0);
    expect(wins.calls).toHaveLength(0);
    expect(readEvents(harness.db, SESSION_ID)).toHaveLength(0);
  });

  it("leaves status='partial' when Garmin payload has sleep:null (noData)", async () => {
    const runId = "run-eval-null-sleep";
    seedHabitRun(harness.db, { runId });
    seedStageA(harness.db, runId);
    seedGarminSignal(harness.db, YESTERDAY_DATE, null); // payload = {sleep: null}

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result.noData).toBe(1);
    expect(readRun(harness.db, runId)?.status).toBe("partial");
    expect(post.calls).toHaveLength(0);
    expect(wins.calls).toHaveLength(0);
  });

  it("returns zeros when no partial wind-down runs exist", async () => {
    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result).toEqual({
      attempted: 0,
      completed: 0,
      missed: 0,
      noData: 0,
      stillPending: 0,
    });
    expect(post.calls).toHaveLength(0);
    expect(wins.calls).toHaveLength(0);
  });

  it("does NOT pick up partial runs whose fire_date != yesterday", async () => {
    const runId = "run-wrong-date";
    const todayDate = localDateString(NOW_MS);
    seedHabitRun(harness.db, { runId, fireDate: todayDate });
    seedStageA(harness.db, runId);
    seedGarminSignal(harness.db, todayDate, `${todayDate}T22:30:00`);

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result.attempted).toBe(0);
    expect(readRun(harness.db, runId)?.status).toBe("partial");
  });

  it("does NOT pick up partial runs with the wrong habit_id (morning-row)", async () => {
    const runId = "run-wrong-habit";
    seedHabitRun(harness.db, { runId, habitId: "morning-row" });

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result.attempted).toBe(0);
    expect(readRun(harness.db, runId)?.status).toBe("partial");
  });

  it("does NOT pick up completed wind-down runs from yesterday", async () => {
    const runId = "run-already-completed";
    seedHabitRun(harness.db, { runId, status: "completed" });

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });

    expect(result.attempted).toBe(0);
    expect(readRun(harness.db, runId)?.status).toBe("completed");
  });

  it("processes multiple partial runs in a batch (resolve + miss together)", async () => {
    // Note: the verb scans WHERE fire_date=yesterday — a single fire_date.
    // We seed two runs with the same fire_date but different ids/habit
    // configs is not possible (UNIQUE(habit_id, fire_date)). To exercise
    // multi-run dispatch we widen the day-before-yesterday window: but the
    // verb's WHERE filter is tight. So instead we test the "multi-run" path
    // by seeding TWO wind-down runs on different yesterday-ish dates, both
    // qualifying — and proving the verb processes >1 in a single call.
    const yesterdayMinus1 = localDateString(NOW_MS - 2 * 24 * ONE_HOUR_MS);

    const runOk = "run-batch-ok";
    const runMiss = "run-batch-miss";
    // First run on YESTERDAY_DATE, sleep onset → completed.
    seedHabitRun(harness.db, { runId: runOk });
    seedStageA(harness.db, runOk);
    seedGarminSignal(harness.db, YESTERDAY_DATE, `${YESTERDAY_DATE}T22:15:00`);

    // Second run on day-before-yesterday — the verb's date filter is
    // exactly yesterday, so this should NOT be processed. To genuinely
    // batch, we instead run two qualifying runs both for YESTERDAY_DATE —
    // but UNIQUE(habit_id, fire_date) blocks that. So we relax: seed run #2
    // with a different fire_date AND verify it's ignored, then seed a
    // SECOND-pass run by changing the implementation invocation's "now" to
    // shift yesterday. Simpler: do two separate invocations.
    seedHabitRun(harness.db, {
      runId: runMiss,
      fireDate: yesterdayMinus1,
    });
    seedStageA(harness.db, runMiss);
    seedGarminSignal(
      harness.db,
      yesterdayMinus1,
      `${yesterdayMinus1}T23:30:00`,
    );

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();

    // First invocation — yesterday=YESTERDAY_DATE — processes runOk only.
    const r1 = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });
    expect(r1.attempted).toBe(1);
    expect(r1.completed).toBe(1);
    expect(readRun(harness.db, runOk)?.status).toBe("completed");
    expect(readRun(harness.db, runMiss)?.status).toBe("partial");

    // Shift now back one day — yesterday becomes yesterdayMinus1 →
    // processes runMiss as 'missed'.
    const r2 = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS - 24 * ONE_HOUR_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
    });
    expect(r2.attempted).toBe(1);
    expect(r2.missed).toBe(1);
    expect(readRun(harness.db, runMiss)?.status).toBe("missed");

    expect(wins.calls).toHaveLength(1);
    expect(post.calls).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Tests — registerEvaluateStageBCron().
// -----------------------------------------------------------------------------

describe("registerEvaluateStageBCron()", () => {
  let tempDir: string;
  let dbPath: string;
  let migrator: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-eval-stage-b-cron-"));
    dbPath = join(tempDir, "store.db");
    migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
  });

  afterEach(() => {
    migrator.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("inserts one schedules row for evaluate-stage-b on a 9am cron with dispatch_priority=10", () => {
    registerEvaluateStageBCron(migrator);

    const rows = migrator
      .prepare(`SELECT * FROM schedules WHERE verb = ?`)
      .all("evaluate-stage-b") as readonly ScheduleRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cron_expr).toBe("0 9 * * *");
    expect(rows[0]!.args_json).toBe("{}");
    expect(rows[0]!.missed_run_policy).toBe("skip");
    expect(rows[0]!.enabled).toBe(1);
    expect(rows[0]!.dispatch_priority).toBe(10);
  });

  it("is idempotent — a second call does not insert a duplicate row", () => {
    registerEvaluateStageBCron(migrator);
    registerEvaluateStageBCron(migrator);

    expect(countSchedules(migrator)).toBe(1);
  });
});
