// Task 4.1: evaluateStageB autonomous completion from pending state.
//
// Tests the new behaviour: the verb now picks up wind-down rows whose
// status is EITHER 'pending' OR 'partial' (was: just 'partial'). For
// pending rows that lack a stage A proof_stages row, the verb decides
// based on Garmin onset alone:
//
//   - onset ≤ stage_b_threshold → complete the run autonomously, write
//     a stage='b' proof_stages row marked autoDetected:true, append a
//     habit_completed event, and post a dual-channel ack (source +
//     #wins). No miss row, no follow-up question.
//   - onset > stage_b_threshold → leave the row pending; the user may
//     still type "shutting down" later. Counts as `stillPending`.
//   - no Garmin row → leave pending; counts as `noData`.
//
// Pinning constraint: the existing partial-path (stage A present)
// behaviour is unchanged — those rows still flow through applyCompleted
// / applyMissed exactly as before. Test 3 below pins that.
//
// References:
//   - docs/plans/2026-05-12-habit-daemon-remediation.md § Phase 4.1
//   - src/orchestrate/reconcile-pending-runs.ts (Phase 1 sibling — same
//     idempotent SQL filter, same dual-channel post pattern).

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
  type ChannelName,
  type DiscordAdapter,
  type PostResult,
} from "../../src/lib/discord-adapter.js";
import type { WindDownCompletion } from "../../src/orchestrate/wins-poster.js";
import { evaluateStageB } from "../../src/orchestrate/evaluate-stage-b.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const SESSION_ID = "session-eval-stage-b-pending-0001";

// Mid-day UTC so "yesterday = now - 24h" lands on May 11 in any plausible TZ.
const NOW_MS = Date.parse("2026-05-12T13:00:00.000Z");
const ONE_HOUR_MS = 3_600_000;

function localDateString(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localHHMM(epochMs: number): string {
  const d = new Date(epochMs);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

const YESTERDAY_DATE = localDateString(NOW_MS - 24 * ONE_HOUR_MS);
const STAGE_A_SATISFIED_AT = NOW_MS - 11 * ONE_HOUR_MS;
const STAGE_A_HHMM = localHHMM(STAGE_A_SATISFIED_AT);
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
    opts.status ?? "pending",
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

interface WindDownPostCall {
  readonly adapter: DiscordAdapter;
  readonly channel: "wind-down";
  readonly content: string;
}

function makeRecordingPostImpl(): {
  readonly impl: (opts: WindDownPostCall) => Promise<PostResult>;
  readonly calls: WindDownPostCall[];
} {
  const calls: WindDownPostCall[] = [];
  const impl = async (opts: WindDownPostCall): Promise<PostResult> => {
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

interface PendingAckCall {
  readonly adapter: DiscordAdapter;
  readonly channel: ChannelName | string;
  readonly content: string;
}

function makeRecordingPendingAckImpl(): {
  readonly impl: (opts: PendingAckCall) => Promise<PostResult>;
  readonly calls: PendingAckCall[];
} {
  const calls: PendingAckCall[] = [];
  const impl = async (opts: PendingAckCall): Promise<PostResult> => {
    calls.push(opts);
    return {
      messageId: `msg-pending-ack-${calls.length}`,
      channelId: opts.channel === "wins" ? "1000000000000000004" : SEED_CHANNELS.windDown,
      postedAt: NOW_MS,
    };
  };
  return { impl, calls };
}

function buildAdapter(): DiscordAdapter {
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
  readonly proof_payload_json: string | null;
}

function readRun(db: Database.Database, runId: string): RunRow | undefined {
  return db
    .prepare(
      `SELECT id, habit_id, fire_date, status, completed_at, next_escalation_at,
              proof_payload_json
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
  readonly run_id: string;
}

function readMissRows(
  db: Database.Database,
  runId: string,
): readonly MissRow[] {
  return db
    .prepare(`SELECT id, run_id FROM miss_reasons WHERE run_id = ?`)
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

// -----------------------------------------------------------------------------
// Harness.
// -----------------------------------------------------------------------------

async function buildHarness(): Promise<{
  tempDir: string;
  sessionStore: SessionStore;
  db: Database.Database;
  adapter: DiscordAdapter;
}> {
  const tempDir = mkdtempSync(
    join(tmpdir(), "habit-daemon-eval-stage-b-pending-"),
  );
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
// Tests.
// -----------------------------------------------------------------------------

describe("evaluateStageB() pending-path autonomy", () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(() => {
    harness.sessionStore.close();
    rmSync(harness.tempDir, { recursive: true, force: true });
  });

  it("completes a pending wind-down run when Garmin onset is at or before threshold", async () => {
    const runId = "run-pending-complete";
    seedHabitRun(harness.db, { runId, status: "pending" });
    // No stage A row — this is the "user never typed shutting down" case.
    seedGarminSignal(harness.db, YESTERDAY_DATE, `${YESTERDAY_DATE}T22:30:00`);

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();
    const pendingAck = makeRecordingPendingAckImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
      pendingAckPostImpl: pendingAck.impl,
    });

    expect(result.attempted).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.missed).toBe(0);
    expect(result.noData).toBe(0);
    expect(result.stillPending).toBe(0);

    const run = readRun(harness.db, runId);
    expect(run?.status).toBe("completed");
    expect(run?.completed_at).toBe(NOW_MS);
    expect(run?.next_escalation_at).toBeNull();

    // proof_payload_json carries the canonical garmin payload.
    expect(run?.proof_payload_json).not.toBeNull();
    const payload = JSON.parse(run!.proof_payload_json!) as {
      proof: { source: string; sleep_onset: string; autoDetected: boolean };
    };
    expect(payload.proof.source).toBe("garmin");
    expect(payload.proof.sleep_onset).toBe("22:30");
    expect(payload.proof.autoDetected).toBe(true);

    // Stage B proof_stages row written with autoDetected:true.
    const stages = readStages(harness.db, runId);
    expect(stages).toHaveLength(1); // ONLY stage B — no stage A inferred.
    expect(stages[0]!.stage).toBe("b");
    expect(stages[0]!.satisfied).toBe(1);
    expect(stages[0]!.satisfied_at).toBe(NOW_MS);
    const stageBData = JSON.parse(stages[0]!.data_json ?? "{}") as {
      stage: string;
      satisfied_at: number;
      sleep_onset_time: string;
      autoDetected: boolean;
    };
    expect(stageBData.stage).toBe("b");
    expect(stageBData.sleep_onset_time).toBe("22:30");
    expect(stageBData.autoDetected).toBe(true);

    // No miss row written.
    expect(readMissRows(harness.db, runId)).toHaveLength(0);

    // habit_completed event appended with autoDetected:true.
    const events = readEvents(harness.db, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("habit_completed");
    expect(events[0]!.trust_level).toBe("L1");
    const eventPayload = JSON.parse(events[0]!.event_json) as {
      habitId: string;
      runId: string;
      stage_b_onset_time: string;
      autoDetected: boolean;
    };
    expect(eventPayload.habitId).toBe("wind-down");
    expect(eventPayload.runId).toBe(runId);
    expect(eventPayload.stage_b_onset_time).toBe("22:30");
    expect(eventPayload.autoDetected).toBe(true);

    // Dual-channel ack: source ("wind-down") + #wins.
    expect(pendingAck.calls).toHaveLength(2);
    const channels = pendingAck.calls.map((c) => c.channel);
    expect(channels).toContain("wind-down");
    expect(channels).toContain("wins");
    // Each post carries the same summary content.
    expect(pendingAck.calls[0]!.content).toBe(pendingAck.calls[1]!.content);
    // Summary references the onset and threshold (formatWindDownSummary).
    expect(pendingAck.calls[0]!.content).toContain("22:30");
    expect(pendingAck.calls[0]!.content).toContain("23:00");

    // The partial-path post seams must NOT fire on the pending-autonomous path.
    expect(post.calls).toHaveLength(0);
    expect(wins.calls).toHaveLength(0);
  });

  it("leaves a pending wind-down run untouched when Garmin onset is after threshold", async () => {
    const runId = "run-pending-late";
    seedHabitRun(harness.db, { runId, status: "pending" });
    // Onset 23:30 > 23:00 threshold.
    seedGarminSignal(harness.db, YESTERDAY_DATE, `${YESTERDAY_DATE}T23:30:00`);

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();
    const pendingAck = makeRecordingPendingAckImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
      pendingAckPostImpl: pendingAck.impl,
    });

    expect(result.attempted).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.missed).toBe(0);
    expect(result.stillPending).toBe(1);

    const run = readRun(harness.db, runId);
    expect(run?.status).toBe("pending");
    expect(run?.completed_at).toBeNull();
    expect(run?.proof_payload_json).toBeNull();

    expect(readStages(harness.db, runId)).toHaveLength(0);
    expect(readMissRows(harness.db, runId)).toHaveLength(0);
    expect(readEvents(harness.db, SESSION_ID)).toHaveLength(0);

    expect(post.calls).toHaveLength(0);
    expect(wins.calls).toHaveLength(0);
    expect(pendingAck.calls).toHaveLength(0);
  });

  it("leaves a pending wind-down run untouched and counts noData when no Garmin row exists", async () => {
    const runId = "run-pending-no-data";
    seedHabitRun(harness.db, { runId, status: "pending" });
    // Intentionally no seedGarminSignal.

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();
    const pendingAck = makeRecordingPendingAckImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
      pendingAckPostImpl: pendingAck.impl,
    });

    expect(result.attempted).toBe(1);
    expect(result.completed).toBe(0);
    expect(result.missed).toBe(0);
    expect(result.noData).toBe(1);
    expect(result.stillPending).toBe(0);

    expect(readRun(harness.db, runId)?.status).toBe("pending");
    expect(readStages(harness.db, runId)).toHaveLength(0);
    expect(post.calls).toHaveLength(0);
    expect(wins.calls).toHaveLength(0);
    expect(pendingAck.calls).toHaveLength(0);
  });

  it("leaves the existing partial-path behavior unchanged (uses applyCompleted + wins-poster)", async () => {
    const runId = "run-partial-still-works";
    // Partial — stage A satisfied.
    seedHabitRun(harness.db, { runId, status: "partial" });
    seedStageA(harness.db, runId);
    seedGarminSignal(harness.db, YESTERDAY_DATE, `${YESTERDAY_DATE}T22:30:00`);

    const post = makeRecordingPostImpl();
    const wins = makeRecordingWinsImpl();
    const pendingAck = makeRecordingPendingAckImpl();

    const result = await evaluateStageB({
      sessionStore: harness.sessionStore,
      adapter: harness.adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: post.impl,
      winsPostImpl: wins.impl,
      pendingAckPostImpl: pendingAck.impl,
    });

    expect(result.attempted).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.missed).toBe(0);
    expect(result.stillPending).toBe(0);

    const run = readRun(harness.db, runId);
    expect(run?.status).toBe("completed");
    expect(run?.completed_at).toBe(NOW_MS);

    // Stage A (seeded) + Stage B (just written).
    const stages = readStages(harness.db, runId);
    expect(stages).toHaveLength(2);
    const stageB = stages.find((s) => s.stage === "b");
    expect(stageB).toBeDefined();
    expect(stageB!.satisfied).toBe(1);
    // The PARTIAL path's stage B data_json does NOT carry autoDetected — that
    // flag is exclusive to the pending-autonomous branch.
    const stageBData = JSON.parse(stageB!.data_json ?? "{}") as {
      stage: string;
      sleep_onset_time: string;
      autoDetected?: boolean;
    };
    expect(stageBData.stage).toBe("b");
    expect(stageBData.sleep_onset_time).toBe("22:30");
    expect(stageBData.autoDetected).toBeUndefined();

    // Existing wins-poster path fires with a fully-typed WindDownCompletion
    // that carries stageATime from the seeded proof_stages row.
    expect(wins.calls).toHaveLength(1);
    expect(wins.calls[0]!.status).toBe("completed");
    expect(wins.calls[0]!.completion).toEqual({
      habit: "wind-down",
      stageATime: STAGE_A_HHMM,
      garminAsleepTime: "22:30",
    });

    // Pending-autonomous seam not invoked on the partial path.
    expect(pendingAck.calls).toHaveLength(0);
    // No miss follow-up post.
    expect(post.calls).toHaveLength(0);

    // Event carries stage_a_time (from the seeded stage A) — confirms the
    // partial path's applyCompleted helper executed.
    const events = readEvents(harness.db, SESSION_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("habit_completed");
    const eventPayload = JSON.parse(events[0]!.event_json) as {
      stage_a_time?: string;
      autoDetected?: boolean;
    };
    expect(eventPayload.stage_a_time).toBe(STAGE_A_HHMM);
    expect(eventPayload.autoDetected).toBeUndefined();
  });
});
