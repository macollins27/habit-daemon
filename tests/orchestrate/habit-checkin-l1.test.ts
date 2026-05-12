// Task 24: tests for runHabitCheckin() at L1 — the first habit-checkin verb
// invocation by the scheduler.
//
// The verb reads habit + run + recent events, composes a prompt via the
// shared prompt-builder, dispatches `claude -p` (mocked here), posts the
// returned message_text to the habit's Discord channel, and atomically
// advances `habit_runs.current_level` + `next_escalation_at` while appending
// a 'habit_prompt_sent' event to session_events.
//
// All side effects beyond the SQLite writes are injected:
//   - `dispatchImpl` substitutes the `claude -p` subprocess.
//   - `postImpl` substitutes `postToChannel` so we never touch a real Discord
//     client. (The verb still receives a real `adapter` for type alignment
//     but the mocked postImpl bypasses it.)
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 24
//   - src/orchestrate/habit-checkin.ts
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (escalation cadence)

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
import {
  runHabitCheckin,
  getEscalationDeltaMinutes,
} from "../../src/orchestrate/habit-checkin.js";

interface HabitRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly status: string;
  readonly current_level: number;
  readonly next_escalation_at: number | null;
  readonly proof_rejection_callout_due: number;
}

interface SessionEventRow {
  readonly id: number;
  readonly session_id: string;
  readonly seq: number;
  readonly event_json: string;
  readonly trust_level: string;
  readonly event_type: string | null;
}

interface CountRow {
  readonly n: number;
}

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

const SESSION_ID = "session-test-0001";
const FIRE_DATE = "2026-05-12";
const NOW_MS = Date.parse("2026-05-12T09:05:00.000Z");

function seedHabitRun(
  db: Database.Database,
  opts: {
    runId: string;
    habitId: string;
    currentLevel?: number;
    calloutDue?: 0 | 1;
    firedAt?: number;
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
    FIRE_DATE,
    opts.firedAt ?? NOW_MS,
    opts.currentLevel ?? 1,
    null,
    "pending",
    null,
    null,
    null,
    opts.calloutDue ?? 0,
  );
}

function getRun(db: Database.Database, runId: string): HabitRunRow | undefined {
  return db
    .prepare("SELECT * FROM habit_runs WHERE id = ?")
    .get(runId) as HabitRunRow | undefined;
}

function getSessionEvents(
  db: Database.Database,
  sessionId: string,
): readonly SessionEventRow[] {
  return db
    .prepare(
      "SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC",
    )
    .all(sessionId) as readonly SessionEventRow[];
}

function countEvents(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as CountRow
  ).n;
}

interface BuildAdapterResult {
  readonly adapter: DiscordAdapter;
  readonly mockSend: ReturnType<typeof vi.fn>;
  readonly mockFetch: ReturnType<typeof vi.fn>;
}

function buildAdapter(): BuildAdapterResult {
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-l1" });
  const mockChannel = {
    send: mockSend,
    isTextBased: () => true,
  };
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
        message_text: "Morning Max. Row time. Send the PM5 photo when done.",
        next_check_in_iso: "2026-05-12T09:35:00.000Z",
      },
    };
  };
  return { impl, calls };
}

describe("getEscalationDeltaMinutes()", () => {
  it("morning-row L1→L2 = 30 min", () => {
    expect(getEscalationDeltaMinutes("morning-row", 1)).toBe(30);
  });

  it("morning-row L2→L3, L3→L4, L4→L5 all = 30 min", () => {
    expect(getEscalationDeltaMinutes("morning-row", 2)).toBe(30);
    expect(getEscalationDeltaMinutes("morning-row", 3)).toBe(30);
    expect(getEscalationDeltaMinutes("morning-row", 4)).toBe(30);
  });

  it("strength-mwf L1→L2..L4→L5 all = 30 min", () => {
    expect(getEscalationDeltaMinutes("strength-mwf", 1)).toBe(30);
    expect(getEscalationDeltaMinutes("strength-mwf", 2)).toBe(30);
    expect(getEscalationDeltaMinutes("strength-mwf", 3)).toBe(30);
    expect(getEscalationDeltaMinutes("strength-mwf", 4)).toBe(30);
  });

  it("wind-down L1→L2 = 8 min", () => {
    expect(getEscalationDeltaMinutes("wind-down", 1)).toBe(8);
  });

  it("wind-down L2→L3 = 5 min", () => {
    expect(getEscalationDeltaMinutes("wind-down", 2)).toBe(5);
  });

  it("wind-down L3→L4 = 2 min", () => {
    expect(getEscalationDeltaMinutes("wind-down", 3)).toBe(2);
  });

  it("throws on unknown habit id", () => {
    expect(() => getEscalationDeltaMinutes("unknown-habit", 1)).toThrow();
  });
});

describe("runHabitCheckin() at L1", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkin-l1-"));
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

  it("happy path morning-row L1: dispatches, posts to morning-row, advances level and next_escalation_at", async () => {
    seedHabitRun(db, { runId: "run-mr-1", habitId: "morning-row" });
    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-1",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toContain("Morning row");
    expect(calls[0]!.prompt).toContain("row");

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["morning-row"]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArg = mockSend.mock.calls[0]![0] as { content: string };
    expect(sendArg.content).toBe(
      "Morning Max. Row time. Send the PM5 photo when done.",
    );

    const row = getRun(db, "run-mr-1");
    expect(row?.current_level).toBe(2);
    expect(row?.next_escalation_at).toBe(NOW_MS + 30 * 60 * 1000);

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("habit_prompt_sent");

    expect(result).toEqual({
      dispatched: true,
      messagePosted: true,
      newLevel: 2,
      nextEscalationAt: NOW_MS + 30 * 60 * 1000,
      calloutFired: false,
    });
  });

  it("wind-down L1: next_escalation_at = now + 8 min, posts to wind-down channel", async () => {
    seedHabitRun(db, { runId: "run-wd-1", habitId: "wind-down" });
    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-wd-1",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["wind-down"]);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const row = getRun(db, "run-wd-1");
    expect(row?.current_level).toBe(2);
    expect(row?.next_escalation_at).toBe(NOW_MS + 8 * 60 * 1000);

    expect(result.nextEscalationAt).toBe(NOW_MS + 8 * 60 * 1000);
  });

  it("strength-mwf L1: posts to strength channel, 30 min cadence", async () => {
    seedHabitRun(db, { runId: "run-st-1", habitId: "strength-mwf" });
    const { adapter, mockFetch } = buildAdapter();
    const { impl } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-st-1",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS.strength);
    const row = getRun(db, "run-st-1");
    expect(row?.next_escalation_at).toBe(NOW_MS + 30 * 60 * 1000);
  });

  it("rejection callout: prompt contains callout, flag resets to 0, calloutFired=true", async () => {
    seedHabitRun(db, {
      runId: "run-mr-cb",
      habitId: "strength-mwf",
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-cb",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain("CALLOUT:");
    expect(calls[0]!.prompt).toContain("training_log");

    const row = getRun(db, "run-mr-cb");
    expect(row?.proof_rejection_callout_due).toBe(0);
    expect(result.calloutFired).toBe(true);
  });

  it("no callout when flag=0: prompt does not contain CALLOUT block, flag stays 0", async () => {
    seedHabitRun(db, {
      runId: "run-no-cb",
      habitId: "morning-row",
      calloutDue: 0,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-no-cb",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).not.toContain("CALLOUT:");
    expect(getRun(db, "run-no-cb")?.proof_rejection_callout_due).toBe(0);
    expect(result.calloutFired).toBe(false);
  });

  it("dispatch failure (returns {error}): no DB writes, throws", async () => {
    seedHabitRun(db, { runId: "run-disp-fail", habitId: "morning-row" });
    const { adapter, mockSend } = buildAdapter();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-disp-fail",
        currentLevel: 1,
        now: NOW_MS,
        dispatchImpl: async () => ({ error: "subprocess timeout" }),
      }),
    ).rejects.toThrowError(/dispatch/i);

    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-disp-fail");
    expect(row?.current_level).toBe(1);
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("schema validation failure (missing message_text): no DB writes, throws", async () => {
    seedHabitRun(db, { runId: "run-bad-schema", habitId: "morning-row" });
    const { adapter, mockSend } = buildAdapter();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-bad-schema",
        currentLevel: 1,
        now: NOW_MS,
        dispatchImpl: async () => ({
          structured_output: { next_check_in_iso: "2026-05-12T09:35:00.000Z" },
        }),
      }),
    ).rejects.toThrowError();

    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-bad-schema");
    expect(row?.current_level).toBe(1);
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("unknown runId throws atomically — no event written, no other state changes", async () => {
    const { adapter } = buildAdapter();
    const { impl } = happyDispatch();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-does-not-exist",
        currentLevel: 1,
        now: NOW_MS,
        dispatchImpl: impl,
      }),
    ).rejects.toThrowError(/habit_run not found/);

    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("session_events row contains habitId, runId, level, messageText, calloutFired", async () => {
    seedHabitRun(db, {
      runId: "run-evt-1",
      habitId: "morning-row",
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-evt-1",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].event_json) as {
      habitId: string;
      runId: string;
      level: number;
      messageText: string;
      calloutFired: boolean;
    };
    expect(payload.habitId).toBe("morning-row");
    expect(payload.runId).toBe("run-evt-1");
    expect(payload.level).toBe(1);
    expect(payload.messageText).toContain("Row time");
    expect(payload.calloutFired).toBe(true);
    expect(events[0].trust_level).toBe("L1");
  });

  it("recent events for this habit are loaded and included in the prompt", async () => {
    // Seed 5 prior session_events with habitId matching the target habit.
    seedHabitRun(db, { runId: "run-recent", habitId: "morning-row" });

    for (let i = 0; i < 5; i += 1) {
      sessionStore.append(
        SESSION_ID,
        "habit_prompt_sent",
        {
          habitId: "morning-row",
          runId: "run-prior",
          note: `PRIOR_EVENT_SENTINEL_${i}`,
        },
        { trustLevel: "L1" },
      );
    }

    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-recent",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    // At least one recent-event sentinel must surface in the prompt.
    const prompt = calls[0]!.prompt;
    const matches = [
      "PRIOR_EVENT_SENTINEL_0",
      "PRIOR_EVENT_SENTINEL_1",
      "PRIOR_EVENT_SENTINEL_2",
      "PRIOR_EVENT_SENTINEL_3",
      "PRIOR_EVENT_SENTINEL_4",
    ].some((s) => prompt.includes(s));
    expect(matches).toBe(true);
  });

  it("unsupported currentLevel throws (L4 not yet wired)", async () => {
    // Task 27 wired L3; L4 lands in Task 30. The verb must still reject any
    // currentLevel above what's wired so the scheduler fails loudly rather
    // than silently no-op'ing an escalation step.
    seedHabitRun(db, {
      runId: "run-l4-rejected",
      habitId: "morning-row",
      currentLevel: 4,
    });
    const { adapter } = buildAdapter();
    const { impl } = happyDispatch();

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-l4-rejected",
        currentLevel: 4,
        now: NOW_MS,
        dispatchImpl: impl,
      }),
    ).rejects.toThrowError();
  });

  it("post failure: postImpl throws — habit_runs not modified (atomicity)", async () => {
    seedHabitRun(db, { runId: "run-post-fail", habitId: "morning-row" });

    // Build an adapter whose mockSend rejects.
    const mockSend = vi
      .fn()
      .mockRejectedValue(new Error("discord rate limited"));
    const mockChannel = { send: mockSend, isTextBased: () => true };
    const mockClient = {
      channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
    };
    const adapter = createDiscordAdapter({
      botToken: "test-bot-token",
      channelIds: CHANNEL_IDS,
      clientFactory: () => mockClient as unknown as Client,
    });

    const { impl } = happyDispatch();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-post-fail",
        currentLevel: 1,
        now: NOW_MS,
        dispatchImpl: impl,
      }),
    ).rejects.toThrowError();

    const row = getRun(db, "run-post-fail");
    expect(row?.current_level).toBe(1);
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });
});
