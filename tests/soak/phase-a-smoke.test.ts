// Task 40: Phase A soak smoke tests.
//
// This file is the COMPOSITION test for Phase A. The unit tests under
// `tests/{daemon,lib,orchestrate,db}` cover each verb / adapter in isolation;
// this suite verifies the parts compose end-to-end through the five major
// flows from the design doc:
//
//   1. Daemon lifecycle: the scheduler-daemon module imports cleanly without
//      auto-starting main(), and its createLoop export is callable.
//   2. Scheduler dispatch: schedulerTick reads a seeded due habit_run and
//      dispatches `habit-checkin` with the expected (verb, JSON args).
//   3. Vision rejection counter: three sequential rejections flip
//      `habit_runs.proof_rejection_callout_due` from 0 to 1 (and event count
//      stays run-isolated via the json_extract($.runId) counter query).
//   4. Sensor adapter stubs: the Python `garmin_fetch.py --stub` returns the
//      five expected fields via the Node bridge, and the Concept2 syncDate
//      caches one sensor_signals row when the mocked fetchImpl returns canned
//      results.
//   5. Stage-B evaluator: a partial wind-down run + a Garmin signal with
//      sleep_onset_time before the stage_b_threshold resolves to 'completed'
//      and posts a #wins row.
//
// All external boundaries (Discord, Claude vision dispatch, Concept2 HTTP)
// are mocked via the same dependency-injection seams used by the unit tests
// (postImpl/winsPostImpl, dispatchImpl, fetchImpl). The Garmin spawn IS real
// against `python3 --stub` — matching Task 12's `tests/lib/garmin-shim.test.ts`
// which assumes a system python3 is present (the Phase A dev/CI invariant).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 40
//   - docs/plans/2026-05-12-habit-daemon-design.md (5 scenarios)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import { schedulerTick } from "../../src/daemon/scheduler.js";
import {
  recordVisionRejection,
  type VisionRejection,
} from "../../src/orchestrate/vision-rejection-counter.js";
import {
  fetchSleep,
  syncDate as garminSyncDate,
  type GarminSleep,
} from "../../src/lib/garmin-adapter.js";
import {
  syncDate as concept2SyncDate,
  type Concept2Credentials,
  type Concept2Result,
  type Concept2Tokens,
} from "../../src/lib/concept2-adapter.js";
import {
  createDiscordAdapter,
  type DiscordAdapter,
  type PostResult,
} from "../../src/lib/discord-adapter.js";
import { verifyImage } from "../../src/lib/vision-verify.js";
import type { WindDownCompletion } from "../../src/orchestrate/wins-poster.js";
import { evaluateStageB } from "../../src/orchestrate/evaluate-stage-b.js";

// -----------------------------------------------------------------------------
// Shared fixtures.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const SESSION_ID = "session-soak-phase-a-0001";

const GARMIN_SCRIPT = resolve(process.cwd(), "scripts/garmin_fetch.py");

/** Build a DiscordAdapter whose underlying Client never receives real calls. */
function buildMockAdapter(): DiscordAdapter {
  const mockClient = {
    channels: {
      fetch: vi
        .fn()
        .mockRejectedValue(
          new Error("client.channels.fetch should not be called in smoke"),
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

/** Format an epoch ms as YYYY-MM-DD in process local time (matches verb impl). */
function localDateString(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format an epoch ms as HH:MM in process local time. */
function localHHMM(epochMs: number): string {
  const d = new Date(epochMs);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// -----------------------------------------------------------------------------
// Smoke 1: daemon lifecycle — module imports cleanly without invoking main().
// -----------------------------------------------------------------------------

describe("Phase A soak — daemon lifecycle", () => {
  it("scheduler-daemon module imports cleanly without auto-starting main()", async () => {
    // The import.meta.url script-mode gate at the bottom of scheduler-daemon.ts
    // means importing this module from a test must NOT invoke main(). If
    // main() were invoked, it would call new Ledger({dbPath:...}) and open
    // an SQLite connection at the default path — that would either throw
    // (no parent dir) or pollute the dev's state dir. So a clean import is
    // evidence the gate works.
    const mod = await import("../../src/daemon/scheduler-daemon.js");

    // Only `createLoop` (and its LoopContext type, which doesn't appear at
    // runtime) is exported. The internal `main`, `makeSubprocessDispatch`,
    // `resolveDbPath` etc. are intentionally module-private.
    expect(typeof mod.createLoop).toBe("function");
    // Spot-check that internal helpers were NOT accidentally exported.
    expect((mod as unknown as Record<string, unknown>).main).toBeUndefined();
    expect(
      (mod as unknown as Record<string, unknown>).makeSubprocessDispatch,
    ).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Smoke 2: scheduler dispatch — due habit_run → habit-checkin dispatched.
// -----------------------------------------------------------------------------

describe("Phase A soak — scheduler dispatch", () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-soak-sched-"));
    const dbPath = join(tempDir, "store.db");
    db = openDatabase(dbPath);
    await runMigrations(db, loadMigrations());
    seedHabits(db, SEED_CHANNELS);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("schedulerTick dispatches habit-checkin with {runId, currentLevel} JSON for due habit_runs", async () => {
    const nowMs = Date.now();
    const runId = "run-soak-due";
    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "morning-row",
      localDateString(nowMs),
      nowMs - 60_000,
      2,
      nowMs - 30_000, // due
      "pending",
      null,
      null,
      null,
      0,
    );

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    // Only one habit-checkin call expected (no schedules rows seeded).
    const checkinCalls = dispatch.mock.calls.filter(
      (c) => c[0] === "habit-checkin",
    );
    expect(checkinCalls).toHaveLength(1);

    const parsed = JSON.parse(checkinCalls[0]![1] as string) as {
      runId: string;
      currentLevel: number;
    };
    expect(parsed).toEqual({ runId, currentLevel: 2 });
  });
});

// -----------------------------------------------------------------------------
// Smoke 3: vision rejection counter — 3rd rejection sets the callout flag.
// -----------------------------------------------------------------------------

describe("Phase A soak — vision rejection counter integration", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-soak-rej-"));
    dbPath = join(tempDir, "store.db");
    const migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, SEED_CHANNELS);
    migrator.close();

    sessionStore = new SessionStore({ dbPath });
    db = sessionStore.db;

    // Seed one habit_run with the flag at 0 — the 3rd rejection should flip it.
    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-soak-rej",
      "morning-row",
      "2026-05-12",
      Date.now(),
      1,
      Date.now() + 60 * 60_000,
      "pending",
      null,
      null,
      null,
      0,
    );
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("3rd rejection flips proof_rejection_callout_due 0 → 1 and writes 3 typed events", () => {
    const rejection: VisionRejection = {
      subject: "pm5_screen",
      reason: "duration_below_threshold",
      parsed: { duration_minutes: 8, distance_m: 1200 },
    };

    const r1 = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: "run-soak-rej",
      rejection,
    });
    const r2 = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: "run-soak-rej",
      rejection,
    });
    const r3 = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: "run-soak-rej",
      rejection,
    });

    expect(r1.rejectionCount).toBe(1);
    expect(r1.calloutDueSet).toBe(false);
    expect(r2.rejectionCount).toBe(2);
    expect(r2.calloutDueSet).toBe(false);
    expect(r3.rejectionCount).toBe(3);
    expect(r3.calloutDueSet).toBe(true);

    interface FlagRow {
      readonly proof_rejection_callout_due: number;
    }
    const flagRow = db
      .prepare(
        `SELECT proof_rejection_callout_due FROM habit_runs WHERE id = ?`,
      )
      .get("run-soak-rej") as FlagRow | undefined;
    expect(flagRow?.proof_rejection_callout_due).toBe(1);

    interface CountRow {
      readonly n: number;
    }
    const events = db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_events
           WHERE event_type = 'proof_attempt_rejected'`,
      )
      .get() as CountRow;
    expect(events.n).toBe(3);
  });

  it("verifyImage rejection path + recordVisionRejection: fail verdict → counter increments", async () => {
    // Compose the wired path: a vision-verify that returns a fail verdict
    // (via mocked dispatchImpl), then the rejection counter consumes the
    // verdict. This is the same wiring the verify-proof verb will use in
    // production (Task 33+).
    const result = await verifyImage({
      imageUrl: "https://example.com/pm5-bad.jpg",
      subject: "pm5_screen",
      dispatchImpl: async () => ({
        structured_output: {
          is_pm5: true,
          duration_minutes: 5, // below 10-min threshold → fail
          meters: 800,
          completed: true,
          confidence: 0.9,
        },
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("min");

    // Counter increments on the rejected verdict.
    const counterResult = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: "run-soak-rej",
      rejection: {
        subject: "pm5_screen",
        reason: result.reason,
        parsed: result.parsed,
      },
    });
    expect(counterResult.rejectionCount).toBe(1);
    expect(counterResult.calloutDueSet).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Smoke 4: sensor adapter stubs — Garmin --stub + Concept2 syncDate.
// -----------------------------------------------------------------------------

describe("Phase A soak — sensor adapter stubs", () => {
  it("Garmin --stub returns the five-field GarminSleep shape via the Node bridge", async () => {
    // Real spawn against python3 --stub. Matches Task 12 / Task 13 test pattern;
    // assumes a system `python3` is present (Phase A dev/CI invariant).
    const sleep = await fetchSleep({
      date: "2026-05-12",
      stub: true,
      pythonBin: "python3",
      scriptPath: GARMIN_SCRIPT,
    });

    // Stub returns canned non-null values for all five fields.
    expect(sleep).not.toBeNull();
    const shape: GarminSleep = sleep!;
    expect(typeof shape.sleep_onset_time).toBe("string");
    expect(typeof shape.total_sleep_minutes).toBe("number");
    expect(typeof shape.rem_minutes).toBe("number");
    expect(typeof shape.deep_sleep_minutes).toBe("number");
    expect(typeof shape.hrv).toBe("number");

    // Canned values from STUB_PAYLOAD in scripts/garmin_fetch.py.
    expect(shape.sleep_onset_time).toBe("2026-05-12T01:23:00");
    expect(shape.total_sleep_minutes).toBe(412);
    expect(shape.rem_minutes).toBe(78);
    expect(shape.deep_sleep_minutes).toBe(65);
    expect(shape.hrv).toBe(51.2);
  });

  it("Garmin syncDate --stub caches one sensor_signals row keyed by garmin-YYYY-MM-DD", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-soak-garmin-"));
    const dbPath = join(tempDir, "store.db");
    const db = openDatabase(dbPath);
    try {
      await runMigrations(db, loadMigrations());

      await garminSyncDate({
        db,
        date: "2026-05-12",
        stub: true,
        pythonBin: "python3",
        scriptPath: GARMIN_SCRIPT,
      });

      interface SensorRow {
        readonly id: string;
        readonly source: string;
        readonly payload_date: string;
        readonly payload_json: string;
      }
      const rows = db
        .prepare(`SELECT id, source, payload_date, payload_json FROM sensor_signals`)
        .all() as readonly SensorRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("garmin-2026-05-12");
      expect(rows[0]!.source).toBe("garmin");
      expect(rows[0]!.payload_date).toBe("2026-05-12");

      const parsed = JSON.parse(rows[0]!.payload_json) as {
        sleep: GarminSleep | null;
      };
      expect(parsed.sleep).not.toBeNull();
      expect(parsed.sleep!.sleep_onset_time).toBe("2026-05-12T01:23:00");
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("Concept2 syncDate caches one sensor_signals row via mocked fetchImpl", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-soak-c2-"));
    const dbPath = join(tempDir, "store.db");
    const db = openDatabase(dbPath);
    try {
      await runMigrations(db, loadMigrations());

      const SAMPLE_ROW: Concept2Result = {
        id: 100,
        date: "2026-05-12 09:15:00",
        type: "rower",
        duration_seconds: 720,
        distance_meters: 2143,
      };

      const credentials: Concept2Credentials = {
        client_id: "test-client-id",
        client_secret: "test-client-secret",
        redirect_uri: "http://localhost:8765/concept2/callback",
      };
      const tokens: Concept2Tokens = {
        access_token: "AT-soak",
        refresh_token: "RT-soak",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
        scope: "user:read,results:read",
      };

      const fetchImpl = (async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [SAMPLE_ROW],
            links: { next: null },
          }),
          text: async () => "",
        } as Response;
      }) as typeof fetch;

      await concept2SyncDate({
        db,
        date: new Date("2026-05-12T10:00:00Z"),
        credentials,
        tokens,
        fetchImpl,
      });

      interface SensorRow {
        readonly id: string;
        readonly source: string;
        readonly payload_date: string;
        readonly payload_json: string;
      }
      const rows = db
        .prepare(`SELECT id, source, payload_date, payload_json FROM sensor_signals`)
        .all() as readonly SensorRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("concept2-2026-05-12");
      expect(rows[0]!.source).toBe("concept2");
      expect(rows[0]!.payload_date).toBe("2026-05-12");

      const parsed = JSON.parse(rows[0]!.payload_json) as {
        results: Concept2Result[];
      };
      expect(parsed.results).toEqual([SAMPLE_ROW]);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("scripts/garmin_fetch.py --stub direct invocation returns valid JSON exit-0", () => {
    // Direct spawn check: the script itself must be wired correctly. This
    // duplicates a slice of Task 12's coverage but is part of the Phase A
    // smoke gate — if the script breaks, the daemon's Garmin path dies.
    const result = spawnSync(
      "python3",
      [
        GARMIN_SCRIPT,
        "--stub",
        "--date",
        "2026-05-12",
        "--fields",
        "sleep_onset_time,total_sleep_minutes,rem_minutes,deep_sleep_minutes,hrv",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "deep_sleep_minutes",
      "hrv",
      "rem_minutes",
      "sleep_onset_time",
      "total_sleep_minutes",
    ]);
  });
});

// -----------------------------------------------------------------------------
// Smoke 5: stage-B evaluator — partial wind-down + Garmin signal → completed.
// -----------------------------------------------------------------------------

describe("Phase A soak — stage-B evaluator", () => {
  let tempDir: string;
  let sessionStore: SessionStore;
  let db: Database.Database;
  let adapter: DiscordAdapter;

  // 2026-05-12 13:00 UTC — same convention as the unit test, lands on
  // YESTERDAY=2026-05-11 across plausible local TZs.
  const NOW_MS = Date.parse("2026-05-12T13:00:00.000Z");
  const ONE_HOUR_MS = 3_600_000;
  const YESTERDAY_DATE = localDateString(NOW_MS - 24 * ONE_HOUR_MS);
  const STAGE_A_SATISFIED_AT = NOW_MS - 11 * ONE_HOUR_MS;
  const STAGE_A_HHMM = localHHMM(STAGE_A_SATISFIED_AT);

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-soak-stage-b-"));
    const dbPath = join(tempDir, "store.db");
    const migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, SEED_CHANNELS);
    migrator.close();
    sessionStore = new SessionStore({ dbPath });
    db = sessionStore.db;
    adapter = buildMockAdapter();
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("evaluateStageB resolves a seeded partial wind-down run to 'completed' + posts to #wins", async () => {
    const runId = "run-soak-stage-b";

    // 1. Seed a partial wind-down run for yesterday.
    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "wind-down",
      YESTERDAY_DATE,
      NOW_MS - 12 * ONE_HOUR_MS,
      1,
      null,
      "partial",
      null,
      null,
      null,
      0,
    );

    // 2. Seed stage A proof (the "shutting down" reply yesterday evening).
    db.prepare(
      `INSERT INTO proof_stages (id, run_id, stage, satisfied, satisfied_at, data_json)
       VALUES (?, ?, 'a', 1, ?, ?)`,
    ).run(
      `proof-${runId}-a`,
      runId,
      STAGE_A_SATISFIED_AT,
      JSON.stringify({
        stage: "a",
        satisfied_at: STAGE_A_SATISFIED_AT,
        message_text: "shutting down",
      }),
    );

    // 3. Seed Garmin signal with onset BEFORE the 23:00 stage_b_threshold.
    db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, 'garmin', ?, ?, ?)`,
    ).run(
      `garmin-${YESTERDAY_DATE}`,
      YESTERDAY_DATE,
      JSON.stringify({
        sleep: {
          sleep_onset_time: `${YESTERDAY_DATE}T22:30:00`,
          total_sleep_minutes: 420,
          rem_minutes: 90,
          deep_sleep_minutes: 60,
          hrv: 55,
        },
      }),
      NOW_MS,
    );

    // 4. Inject test seams for both Discord posts so the smoke never reaches
    //    the real Discord client.
    const winsCalls: { completion: WindDownCompletion }[] = [];
    const followUpCalls: { content: string }[] = [];
    const winsImpl = async (opts: {
      adapter: DiscordAdapter;
      status: "completed";
      completion: WindDownCompletion;
    }): Promise<{ posted: boolean; messageId?: string }> => {
      winsCalls.push({ completion: opts.completion });
      return { posted: true, messageId: "msg-wins-soak" };
    };
    const followUpImpl = async (opts: {
      adapter: DiscordAdapter;
      channel: "wind-down";
      content: string;
    }): Promise<PostResult> => {
      followUpCalls.push({ content: opts.content });
      return {
        messageId: "msg-followup-soak",
        channelId: SEED_CHANNELS.windDown,
        postedAt: NOW_MS,
      };
    };

    // 5. Run the verb.
    const result = await evaluateStageB({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      now: NOW_MS,
      postImpl: followUpImpl,
      winsPostImpl: winsImpl,
    });

    // 6. Verb-level result: 1 partial → 1 completed.
    expect(result).toEqual({
      attempted: 1,
      completed: 1,
      missed: 0,
      noData: 0,
      stillPending: 0,
    });

    // 7. habit_runs.status transitioned to 'completed'.
    interface RunRow {
      readonly status: string;
      readonly completed_at: number | null;
    }
    const run = db
      .prepare(`SELECT status, completed_at FROM habit_runs WHERE id = ?`)
      .get(runId) as RunRow | undefined;
    expect(run?.status).toBe("completed");
    expect(run?.completed_at).toBe(NOW_MS);

    // 8. proof_stages stage='b' row inserted.
    interface ProofStageRow {
      readonly stage: string;
      readonly satisfied: number;
      readonly data_json: string | null;
    }
    const stages = db
      .prepare(
        `SELECT stage, satisfied, data_json FROM proof_stages WHERE run_id = ? ORDER BY stage`,
      )
      .all(runId) as readonly ProofStageRow[];
    expect(stages).toHaveLength(2);
    const stageB = stages.find((s) => s.stage === "b");
    expect(stageB).toBeDefined();
    expect(stageB!.satisfied).toBe(1);

    // 9. #wins post invoked with the completion payload.
    expect(winsCalls).toHaveLength(1);
    expect(winsCalls[0]!.completion).toEqual({
      habit: "wind-down",
      stageATime: STAGE_A_HHMM,
      garminAsleepTime: "22:30",
    });

    // 10. No #wind-down follow-up on completion.
    expect(followUpCalls).toHaveLength(0);

    // 11. habit_completed session_event appended at L1.
    interface SessionEventRow {
      readonly event_type: string | null;
      readonly trust_level: string;
    }
    const events = db
      .prepare(
        `SELECT event_type, trust_level FROM session_events WHERE session_id = ?`,
      )
      .all(SESSION_ID) as readonly SessionEventRow[];
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("habit_completed");
    expect(events[0]!.trust_level).toBe("L1");
  });
});
