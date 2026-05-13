// Task 38: defensive guard for morning-row L1 against an unresolved wind-down
// stage-B from the previous night.
//
// Design § 3 mandates two enforcement mechanisms so morning-row L1 never
// dispatches before wind-down stage-B has been evaluated:
//   1. `dispatch_priority` column on `schedules` (Task 16 + Task 32). The
//      scheduler tick sorts so stage-B (priority=10) runs before morning-row
//      (priority=100).
//   2. A defensive guard inside habit-checkin itself: when invoked for
//      `morning-row` at L1, the verb queries
//          SELECT 1 FROM habit_runs
//           WHERE habit_id = 'wind-down'
//             AND status = 'partial'
//             AND fire_date = yesterday()
//           LIMIT 1
//      and, if found, defers itself by 60s (UPDATE next_escalation_at = now +
//      60_000) without dispatching the model or posting to Discord.
//
// Belt + suspenders. If the scheduler ordering is bypassed (timing race,
// missed cron tick, manual invocation), the guard absorbs the call so
// stage-B has another minute to complete.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 38
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3
//   - src/orchestrate/habit-checkin.ts (runHabitCheckin)

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
// Fixtures.
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

const SESSION_ID = "session-defensive-guard-0001";

// Mid-day UTC so "yesterday = now - 24h" lands on the prior local date in any
// plausible TZ a developer might run tests in.
const NOW_MS = Date.parse("2026-05-12T13:00:00.000Z");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function localDateString(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const TODAY_DATE = localDateString(NOW_MS);
const YESTERDAY_DATE = localDateString(NOW_MS - ONE_DAY_MS);

// -----------------------------------------------------------------------------
// Seed helpers.
// -----------------------------------------------------------------------------

interface SeedRunOpts {
  readonly runId: string;
  readonly habitId: string;
  readonly status?: string;
  readonly fireDate?: string;
  readonly currentLevel?: number;
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
    opts.habitId,
    opts.fireDate ?? TODAY_DATE,
    NOW_MS,
    opts.currentLevel ?? 1,
    null,
    opts.status ?? "pending",
    null,
    null,
    null,
    0,
  );
}

interface HabitRunRow {
  readonly id: string;
  readonly current_level: number;
  readonly next_escalation_at: number | null;
  readonly status: string;
}

function getRun(db: Database.Database, runId: string): HabitRunRow | undefined {
  return db
    .prepare(
      `SELECT id, current_level, next_escalation_at, status
         FROM habit_runs
        WHERE id = ?`,
    )
    .get(runId) as HabitRunRow | undefined;
}

interface CountRow {
  readonly n: number;
}

function countEvents(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as CountRow
  ).n;
}

// -----------------------------------------------------------------------------
// Mock infrastructure.
// -----------------------------------------------------------------------------

interface BuildAdapterResult {
  readonly adapter: DiscordAdapter;
  readonly mockSend: ReturnType<typeof vi.fn>;
  readonly mockFetch: ReturnType<typeof vi.fn>;
}

function buildAdapter(): BuildAdapterResult {
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-guard" });
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

function happyDispatch(): {
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
        message_text: "Row time, Max. PM5 photo when done.",
        next_check_in_iso: "2026-05-12T09:35:00.000Z",
      },
    };
  };
  return { impl, calls };
}

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("runHabitCheckin() defensive guard (morning-row L1 + wind-down partial)", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-defensive-guard-"));
    dbPath = join(tempDir, "store.db");

    const migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, SEED_CHANNELS);
    migrator.close();

    sessionStore = new SessionStore({ dbPath });
    db = sessionStore.db;
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("wind-down partial yesterday + morning-row L1 today → defer 60s, no dispatch, no post", async () => {
    seedHabitRun(db, {
      runId: "run-wd-yesterday",
      habitId: "wind-down",
      status: "partial",
      fireDate: YESTERDAY_DATE,
    });
    seedHabitRun(db, {
      runId: "run-mr-today",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
    });

    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();
    const eventsBefore = countEvents(db);

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    // Dispatch + post not called.
    expect(calls.length).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();

    // No new session_events appended.
    expect(countEvents(db)).toBe(eventsBefore);

    // Result shape: deferred.
    expect(result).toEqual({
      dispatched: false,
      messagePosted: false,
      newLevel: 1,
      nextEscalationAt: NOW_MS + 60 * 1000,
      calloutFired: false,
    });

    // Row state: level stayed at 1, next_escalation_at = now + 60s.
    const row = getRun(db, "run-mr-today");
    expect(row?.current_level).toBe(1);
    expect(row?.next_escalation_at).toBe(NOW_MS + 60 * 1000);
    expect(row?.status).toBe("pending");
  });

  it("no wind-down partial → morning-row L1 fires normally", async () => {
    seedHabitRun(db, {
      runId: "run-mr-today",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
    });

    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
    expect(result.messagePosted).toBe(true);
    expect(result.newLevel).toBe(2);
    expect(result.nextEscalationAt).toBe(NOW_MS + 30 * 60 * 1000);
  });

  it("wind-down completed (not partial) yesterday → morning-row L1 fires", async () => {
    seedHabitRun(db, {
      runId: "run-wd-yesterday-completed",
      habitId: "wind-down",
      status: "completed",
      fireDate: YESTERDAY_DATE,
    });
    seedHabitRun(db, {
      runId: "run-mr-today",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
    });

    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
    expect(result.newLevel).toBe(2);
  });

  it("wind-down missed (not partial) yesterday → morning-row L1 fires", async () => {
    seedHabitRun(db, {
      runId: "run-wd-yesterday-missed",
      habitId: "wind-down",
      status: "missed",
      fireDate: YESTERDAY_DATE,
    });
    seedHabitRun(db, {
      runId: "run-mr-today",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
    });

    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
    expect(result.newLevel).toBe(2);
  });

  it("wind-down partial TODAY (not yesterday) → morning-row L1 fires", async () => {
    // A partial wind-down with fire_date = today (e.g. some testing scenario)
    // must NOT trigger the guard — the guard is yesterday-specific.
    seedHabitRun(db, {
      runId: "run-wd-today-partial",
      habitId: "wind-down",
      status: "partial",
      fireDate: TODAY_DATE,
    });
    // morning-row uses a different fire_date so the UNIQUE(habit_id, fire_date)
    // constraint isn't relevant — we seed morning-row also for today, distinct
    // habit_id.
    seedHabitRun(db, {
      runId: "run-mr-today",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
    });

    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
    expect(result.newLevel).toBe(2);
  });

  it("strength-mwf L1: guard does NOT apply even with wind-down partial yesterday", async () => {
    seedHabitRun(db, {
      runId: "run-wd-yesterday",
      habitId: "wind-down",
      status: "partial",
      fireDate: YESTERDAY_DATE,
    });
    seedHabitRun(db, {
      runId: "run-strength-today",
      habitId: "strength-mwf",
      fireDate: TODAY_DATE,
    });

    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-strength-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
    expect(result.newLevel).toBe(2);
  });

  it("morning-row at L2 (not L1): guard does NOT apply even with wind-down partial yesterday", async () => {
    seedHabitRun(db, {
      runId: "run-wd-yesterday",
      habitId: "wind-down",
      status: "partial",
      fireDate: YESTERDAY_DATE,
    });
    seedHabitRun(db, {
      runId: "run-mr-today-l2",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
      currentLevel: 2,
    });

    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today-l2",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
    expect(result.newLevel).toBe(3);
  });

  it("wind-down today at L1: guard does NOT apply (guard is morning-row-specific, not wind-down)", async () => {
    // Yesterday's wind-down is partial (would trigger guard for morning-row),
    // but today's wind-down at L1 is a different habit — the guard's habitId
    // check is `=== 'morning-row'`, so wind-down skips the guard entirely.
    seedHabitRun(db, {
      runId: "run-wd-yesterday",
      habitId: "wind-down",
      status: "partial",
      fireDate: YESTERDAY_DATE,
    });
    seedHabitRun(db, {
      runId: "run-wd-today",
      habitId: "wind-down",
      fireDate: TODAY_DATE,
    });

    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-wd-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(true);
    expect(result.newLevel).toBe(2);
  });

  it("deferred result shape: dispatched=false, messagePosted=false, newLevel unchanged", async () => {
    seedHabitRun(db, {
      runId: "run-wd-yesterday",
      habitId: "wind-down",
      status: "partial",
      fireDate: YESTERDAY_DATE,
    });
    seedHabitRun(db, {
      runId: "run-mr-today",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
    });

    const { adapter } = buildAdapter();
    const { impl } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(result.dispatched).toBe(false);
    expect(result.messagePosted).toBe(false);
    expect(result.newLevel).toBe(1);
    expect(result.calloutFired).toBe(false);
    expect(result.nextEscalationAt).toBe(NOW_MS + 60 * 1000);
  });

  it("idempotency: deferred twice — each call extends next_escalation_at, no dispatch on either", async () => {
    seedHabitRun(db, {
      runId: "run-wd-yesterday",
      habitId: "wind-down",
      status: "partial",
      fireDate: YESTERDAY_DATE,
    });
    seedHabitRun(db, {
      runId: "run-mr-today",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
    });

    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const firstNow = NOW_MS;
    const result1 = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: firstNow,
      dispatchImpl: impl,
    });

    expect(result1.dispatched).toBe(false);
    expect(result1.nextEscalationAt).toBe(firstNow + 60 * 1000);
    expect(getRun(db, "run-mr-today")?.next_escalation_at).toBe(
      firstNow + 60 * 1000,
    );

    // Second invocation 30 seconds later — guard still active.
    const secondNow = firstNow + 30_000;
    const result2 = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: secondNow,
      dispatchImpl: impl,
    });

    expect(result2.dispatched).toBe(false);
    expect(result2.nextEscalationAt).toBe(secondNow + 60 * 1000);
    expect(getRun(db, "run-mr-today")?.next_escalation_at).toBe(
      secondNow + 60 * 1000,
    );

    expect(calls.length).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
