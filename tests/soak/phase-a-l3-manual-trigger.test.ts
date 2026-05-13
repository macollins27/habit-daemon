// Task 41: Phase A L3 manual-trigger falsifiability test scenarios.
//
// Design § 6 (Phase A soak criteria) lists:
//   - "L3 stakes_well rotation observed (or manually triggered via Task 41
//     and verified)"
//   - "L3 body_data_well firing observed when sensor anomalies present (or
//     manually triggered + verified)"
//
// If the founder is in a high-compliance week, no L3 fires organically.
// Task 41's job is to PROVE the three L3 selector branches (stakes,
// body_data, pattern) work end-to-end for each of the three Phase A habits
// without waiting for a real miss. Each test:
//   1. Spins up a temp SQLite store + migrations + seedHabits.
//   2. Seeds whatever context that branch needs (or doesn't need): no
//      pattern + no body anomaly → stakes; prior-night anomaly → body_data;
//      3+ matching slug miss_reasons → pattern.
//   3. Seeds a synthetic habit_run at currentLevel = 3.
//   4. Invokes runHabitCheckin with a mocked dispatch + mocked Discord post.
//   5. Asserts the selector picked the expected well, the prompt mentions
//      the expected payload, and the persisted session_event carries the
//      expected metadata so an auditor can reconstruct what fired.
//
// The companion CLI `bin/simulate-miss.ts` is a manual diagnostic; its core
// flow is the same as these tests. The tests are the falsifiability proof —
// the CLI is the operator's one-liner.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 41
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (L3 WHY-well rules)
//   - bin/simulate-miss.ts (companion CLI)
//   - src/orchestrate/habit-checkin.ts (verb under test)
//   - src/lib/why-well-selector.ts (selector under test)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { type Client } from "discord.js";
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
  type DiscordChannelIds,
} from "../../src/lib/discord-adapter.js";
import { runHabitCheckin } from "../../src/orchestrate/habit-checkin.js";

// -----------------------------------------------------------------------------
// Shared fixtures
// -----------------------------------------------------------------------------

const CHANNEL_IDS: DiscordChannelIds = {
  "morning-row": "1000000000000000001",
  strength: "1000000000000000002",
  "wind-down": "1000000000000000003",
  wins: "1000000000000000004",
  "sunday-review": "1000000000000000005",
};

const SEED_CHANNELS = {
  morningRow: CHANNEL_IDS["morning-row"],
  strength: CHANNEL_IDS.strength,
  windDown: CHANNEL_IDS["wind-down"],
} as const;

const SESSION_ID = "session-soak-l3-manual-0001";
const FIRE_DATE = "2026-05-12";
const NOW_MS = Date.parse("2026-05-12T10:05:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// The three Phase A habit ids — each L3 selector branch is exercised against
// every habit so a regression in any habit's why_stakes_json or cadence
// table is caught here.
const PHASE_A_HABITS = ["morning-row", "strength-mwf", "wind-down"] as const;
type PhaseAHabit = (typeof PHASE_A_HABITS)[number];

// The locked Phase A stakes (verbatim from src/db/seed-habits.ts). With no
// prior stakes_well usage stamped in session_events, the selector returns
// `primary` for every habit.
const STAKE_PRIMARY =
  "12 months post T9-T12 compression fracture, recovery stalled";

// Per-habit L3→L4 cadence delta in minutes (mirrors ESCALATION_DELTA_MINUTES
// in src/orchestrate/habit-checkin.ts so a cadence change without a test
// update fails this suite loudly).
const L3_DELTA_MINUTES: Readonly<Record<PhaseAHabit, number>> = {
  "morning-row": 30,
  "strength-mwf": 30,
  "wind-down": 2,
};

interface HabitRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly status: string;
  readonly current_level: number;
  readonly next_escalation_at: number | null;
}

interface SessionEventRow {
  readonly event_json: string;
  readonly event_type: string | null;
}

function seedHabitRun(
  db: Database.Database,
  opts: {
    runId: string;
    habitId: string;
    fireDate?: string;
    currentLevel?: number;
  },
): void {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.habitId,
    opts.fireDate ?? FIRE_DATE,
    NOW_MS,
    opts.currentLevel ?? 3,
    null,
    "pending",
    null,
    null,
    null,
    0,
  );
}

function getRun(
  db: Database.Database,
  runId: string,
): HabitRunRow | undefined {
  return db
    .prepare("SELECT * FROM habit_runs WHERE id = ?")
    .get(runId) as HabitRunRow | undefined;
}

function getLatestPromptEvent(
  db: Database.Database,
  sessionId: string,
): SessionEventRow | undefined {
  return db
    .prepare(
      `SELECT event_json, event_type FROM session_events
        WHERE session_id = ?
          AND event_type = 'habit_prompt_sent'
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(sessionId) as SessionEventRow | undefined;
}

interface BuildAdapterResult {
  readonly adapter: DiscordAdapter;
  readonly mockSend: ReturnType<typeof vi.fn>;
  readonly mockFetch: ReturnType<typeof vi.fn>;
}

function buildAdapter(): BuildAdapterResult {
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-l3-manual" });
  const mockChannel = { send: mockSend, isTextBased: () => true };
  const mockFetch = vi.fn().mockResolvedValue(mockChannel);
  const mockClient = { channels: { fetch: mockFetch } };
  const adapter = createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: CHANNEL_IDS,
    clientFactory: () => mockClient as unknown as Client,
  });
  return { adapter, mockSend, mockFetch };
}

interface DispatchCall {
  readonly prompt: string;
  readonly jsonSchema: string;
}

function happyDispatch(message: string): {
  readonly impl: (opts: { prompt: string; jsonSchema: string }) => Promise<{
    structured_output: { message_text: string; next_check_in_iso: string };
  }>;
  readonly calls: DispatchCall[];
} {
  const calls: DispatchCall[] = [];
  const impl = async (opts: {
    prompt: string;
    jsonSchema: string;
  }): Promise<{
    structured_output: { message_text: string; next_check_in_iso: string };
  }> => {
    calls.push({ prompt: opts.prompt, jsonSchema: opts.jsonSchema });
    return {
      structured_output: {
        message_text: message,
        next_check_in_iso: "2026-05-12T10:35:00.000Z",
      },
    };
  };
  return { impl, calls };
}

/**
 * Insert 30 baseline Garmin rows with normal rem_minutes and one prior-night
 * row whose rem_minutes is in the bottom 20%. Used to force the body_data
 * branch for prior_night signal_mode habits (row + strength).
 */
function seedBodyDataPriorNightAnomaly(
  db: Database.Database,
  opts: {
    priorDate: string;
    baselineRem: number;
    priorNightRem: number;
  },
): void {
  const insert = db.prepare(
    `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(NOW_MS - (i + 2) * DAY_MS);
    const ymd = d.toISOString().slice(0, 10);
    insert.run(
      `ss-baseline-${i}`,
      "garmin",
      ymd,
      JSON.stringify({ sleep: { rem_minutes: opts.baselineRem } }),
      NOW_MS - (i + 2) * DAY_MS,
    );
  }
  insert.run(
    "ss-prior-night",
    "garmin",
    opts.priorDate,
    JSON.stringify({ sleep: { rem_minutes: opts.priorNightRem } }),
    NOW_MS - DAY_MS,
  );
}

/**
 * Insert 30 Garmin rows where the trailing 7 days carry a much lower hrv
 * average than the prior 23 days. Used to force the body_data branch for
 * wind-down (trailing_week_trend signal_mode). hrv delta is ~30% which is
 * well above the 10% relative threshold in src/lib/anomaly-detector.ts.
 *
 * fetched_at must fall inside the verb's trailing-30-day loader window
 * (`fetched_at >= now - 30 days`), so we anchor every row to NOW_MS minus
 * its age in days.
 */
function seedBodyDataTrailingWeekAnomaly(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= 7; i += 1) {
    const d = new Date(NOW_MS - i * DAY_MS);
    const ymd = d.toISOString().slice(0, 10);
    insert.run(
      `ss-recent-${i}`,
      "garmin",
      ymd,
      JSON.stringify({ sleep: { hrv: 35 } }),
      NOW_MS - i * DAY_MS,
    );
  }
  for (let i = 8; i <= 28; i += 1) {
    const d = new Date(NOW_MS - i * DAY_MS);
    const ymd = d.toISOString().slice(0, 10);
    insert.run(
      `ss-baseline-${i}`,
      "garmin",
      ymd,
      JSON.stringify({ sleep: { hrv: 50 } }),
      NOW_MS - i * DAY_MS,
    );
  }
}

/**
 * Insert 3 prior habit_runs + 3 miss_reasons with the same slug prefix
 * inside the trailing-28-day window. The pattern detector's threshold is
 * 3; the 14-day-cooldown gate is open because no prior pattern_well event
 * is in session_events.
 */
function seedPatternMissReasons(
  db: Database.Database,
  habitId: string,
  slug: string,
): void {
  const insertRun = db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMr = db.prepare(
    `INSERT INTO miss_reasons (id, habit_id, run_id, miss_date,
                               inferred_specifics, classification, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 3; i += 1) {
    const priorMs = NOW_MS - (i + 1) * DAY_MS;
    const priorDate = new Date(priorMs).toISOString().slice(0, 10);
    insertRun.run(
      `prior-run-${habitId}-${i}`,
      habitId,
      priorDate,
      priorMs,
      5,
      null,
      "missed",
      null,
      null,
      null,
      0,
    );
    insertMr.run(
      `mr-${habitId}-${i}`,
      habitId,
      `prior-run-${habitId}-${i}`,
      priorDate,
      slug,
      "gaming",
      priorMs,
    );
  }
}

// -----------------------------------------------------------------------------
// Shared per-test SQLite plumbing.
// -----------------------------------------------------------------------------

interface Harness {
  tempDir: string;
  sessionStore: SessionStore;
  db: Database.Database;
}

async function setupHarness(prefix: string): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), `habit-daemon-${prefix}-`));
  const dbPath = join(tempDir, "store.db");
  const migrator = openDatabase(dbPath);
  await runMigrations(migrator, loadMigrations());
  seedHabits(migrator, SEED_CHANNELS);
  migrator.close();
  const sessionStore = new SessionStore({ dbPath });
  return { tempDir, sessionStore, db: sessionStore.db };
}

function teardownHarness(h: Harness): void {
  h.sessionStore.close();
  rmSync(h.tempDir, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------
// L3 stakes branch — every habit, no prior context → primary stake.
// -----------------------------------------------------------------------------

describe("Phase A L3 falsifiability — stakes branch", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness("soak-l3-stakes");
  });

  afterEach(() => {
    teardownHarness(h);
  });

  for (const habit of PHASE_A_HABITS) {
    it(`${habit}: L3 stakes path dispatches with primary stake + advances level + writes well/stake event`, async () => {
      const runId = `manual-l3-stakes-${habit}`;
      seedHabitRun(h.db, { runId, habitId: habit });

      const { adapter, mockSend, mockFetch } = buildAdapter();
      const { impl, calls } = happyDispatch(
        "12 months post-fracture. The work IS the recovery. Where are we?",
      );

      const result = await runHabitCheckin({
        sessionStore: h.sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId,
        currentLevel: 3,
        now: NOW_MS,
        dispatchImpl: impl,
      });

      // Dispatch was invoked with an L3 prompt containing the primary stake.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toContain("L3");
      expect(calls[0]!.prompt).toContain(STAKE_PRIMARY);

      // Discord post happened on the habit's channel.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Run advanced to L4 with the per-habit cadence delta.
      const row = getRun(h.db, runId);
      const expectedNextAt = NOW_MS + L3_DELTA_MINUTES[habit] * 60 * 1000;
      expect(row?.current_level).toBe(4);
      expect(row?.next_escalation_at).toBe(expectedNextAt);

      // Persisted event carries well='stakes' + stake='primary'.
      const event = getLatestPromptEvent(h.db, SESSION_ID);
      expect(event).toBeDefined();
      const payload = JSON.parse(event!.event_json) as {
        habitId: string;
        level: number;
        well: string;
        stake: string;
        messageText: string;
      };
      expect(payload.habitId).toBe(habit);
      expect(payload.level).toBe(3);
      expect(payload.well).toBe("stakes");
      expect(payload.stake).toBe("primary");
      expect(payload.messageText.length).toBeGreaterThan(0);

      // Verb-level return matches the persisted state.
      expect(result.dispatched).toBe(true);
      expect(result.messagePosted).toBe(true);
      expect(result.newLevel).toBe(4);
      expect(result.nextEscalationAt).toBe(expectedNextAt);
    });
  }
});

// -----------------------------------------------------------------------------
// L3 body_data branch — prior_night anomaly for row + strength, trailing-week
// anomaly for wind-down (per design § 2 signal_mode split).
// -----------------------------------------------------------------------------

describe("Phase A L3 falsifiability — body_data branch", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness("soak-l3-body");
  });

  afterEach(() => {
    teardownHarness(h);
  });

  for (const habit of ["morning-row", "strength-mwf"] as const) {
    it(`${habit}: L3 body_data prior_night path dispatches with anomalous signal name + writes anomalousSignals event`, async () => {
      const runId = `manual-l3-body-${habit}`;
      seedHabitRun(h.db, { runId, habitId: habit });
      seedBodyDataPriorNightAnomaly(h.db, {
        priorDate: "2026-05-11",
        baselineRem: 120,
        priorNightRem: 10,
      });

      const { adapter, mockSend, mockFetch } = buildAdapter();
      const { impl, calls } = happyDispatch(
        "REM was bottom 15% of your month — the work primes parasympathetic recovery.",
      );

      const result = await runHabitCheckin({
        sessionStore: h.sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId,
        currentLevel: 3,
        now: NOW_MS,
        dispatchImpl: impl,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toContain("L3");
      expect(calls[0]!.prompt).toContain("rem_minutes");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(1);

      const row = getRun(h.db, runId);
      expect(row?.current_level).toBe(4);
      expect(row?.next_escalation_at).toBe(
        NOW_MS + L3_DELTA_MINUTES[habit] * 60 * 1000,
      );

      const event = getLatestPromptEvent(h.db, SESSION_ID);
      expect(event).toBeDefined();
      const payload = JSON.parse(event!.event_json) as {
        habitId: string;
        level: number;
        well: string;
        anomalousSignals: readonly string[];
      };
      expect(payload.habitId).toBe(habit);
      expect(payload.level).toBe(3);
      expect(payload.well).toBe("body_data");
      expect(payload.anomalousSignals).toEqual(["rem_minutes"]);

      expect(result.dispatched).toBe(true);
      expect(result.newLevel).toBe(4);
    });
  }

  it("wind-down: L3 body_data trailing_week_trend path dispatches when 7d hrv avg drops > 10% vs baseline", async () => {
    const runId = "manual-l3-body-wind-down";
    seedHabitRun(h.db, { runId, habitId: "wind-down" });
    seedBodyDataTrailingWeekAnomaly(h.db);

    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch(
      "Last 7 days HRV trending down — wind-down keeps the autonomic system off the hook.",
    );

    const result = await runHabitCheckin({
      sessionStore: h.sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId,
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("L3");
    expect(calls[0]!.prompt).toContain("hrv");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const row = getRun(h.db, runId);
    expect(row?.current_level).toBe(4);
    expect(row?.next_escalation_at).toBe(
      NOW_MS + L3_DELTA_MINUTES["wind-down"] * 60 * 1000,
    );

    const event = getLatestPromptEvent(h.db, SESSION_ID);
    expect(event).toBeDefined();
    const payload = JSON.parse(event!.event_json) as {
      habitId: string;
      level: number;
      well: string;
      anomalousSignals: readonly string[];
    };
    expect(payload.habitId).toBe("wind-down");
    expect(payload.level).toBe(3);
    expect(payload.well).toBe("body_data");
    expect(payload.anomalousSignals).toContain("hrv");

    expect(result.dispatched).toBe(true);
    expect(result.newLevel).toBe(4);
  });
});

// -----------------------------------------------------------------------------
// L3 pattern branch — every habit, 3+ same-slug miss_reasons in the trailing
// 28-day window. Pattern beats body_data + stakes in the selector chain, so
// the body_data baseline rows are NOT seeded here.
// -----------------------------------------------------------------------------

describe("Phase A L3 falsifiability — pattern branch", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness("soak-l3-pattern");
  });

  afterEach(() => {
    teardownHarness(h);
  });

  for (const habit of PHASE_A_HABITS) {
    it(`${habit}: L3 pattern path dispatches with slug-prefix observation + writes slugPrefix/patternCount event`, async () => {
      const runId = `manual-l3-pattern-${habit}`;
      const slug = "late-gaming-friend:brian";
      seedHabitRun(h.db, { runId, habitId: habit });
      seedPatternMissReasons(h.db, habit, slug);

      const { adapter, mockSend, mockFetch } = buildAdapter();
      const { impl, calls } = happyDispatch(
        "Third time in 28 days for the same reason. We figure it out now or it becomes the pattern.",
      );

      const result = await runHabitCheckin({
        sessionStore: h.sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId,
        currentLevel: 3,
        now: NOW_MS,
        dispatchImpl: impl,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toContain("L3");
      // The pattern voice rules name the slug prefix (before the colon) and
      // the count. Both must show up so the model has the falsifiable shape.
      expect(calls[0]!.prompt).toContain("late-gaming-friend");
      expect(calls[0]!.prompt).toContain("3");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(1);

      const row = getRun(h.db, runId);
      expect(row?.current_level).toBe(4);
      expect(row?.next_escalation_at).toBe(
        NOW_MS + L3_DELTA_MINUTES[habit] * 60 * 1000,
      );

      const event = getLatestPromptEvent(h.db, SESSION_ID);
      expect(event).toBeDefined();
      const payload = JSON.parse(event!.event_json) as {
        habitId: string;
        level: number;
        well: string;
        slugPrefix: string;
        patternCount: number;
      };
      expect(payload.habitId).toBe(habit);
      expect(payload.level).toBe(3);
      expect(payload.well).toBe("pattern");
      expect(payload.slugPrefix).toBe("late-gaming-friend");
      expect(payload.patternCount).toBe(3);

      expect(result.dispatched).toBe(true);
      expect(result.newLevel).toBe(4);
    });
  }
});
