// Task 25: tests for runHabitCheckin() at L2 — the curious check-in.
//
// L2 fires the second escalation step. The voice is curious-not-loaded — no
// stakes, no body data, no patterns, just a brief "noticed no row yet, what's
// going on?" nudge. Same output schema as L1 (one message_text + one
// next_check_in_iso), same DI seams (dispatchImpl, postImpl), same atomicity
// guarantees (dispatch + post happen before the DB transaction; all SQLite
// writes go through one better-sqlite3 transaction).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 25
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 ("Curious check-in,
//     no why yet. 'No row yet — what's going on?'")
//   - src/orchestrate/habit-checkin.ts (verb under test)
//   - src/lib/prompt-templates/level-2.ts (LEVEL_2_TEMPLATE)

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
import { LEVEL_2_TEMPLATE } from "../../src/lib/prompt-templates/level-2.js";

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

const SESSION_ID = "session-test-l2-0001";
const FIRE_DATE = "2026-05-12";
// L2 fires 30 minutes after L1 for morning-row/strength, 8 minutes after
// for wind-down. The verb computes next_escalation_at off the injected `now`,
// so the exact fired_at vs now offset doesn't matter for these tests.
const NOW_MS = Date.parse("2026-05-12T09:35:00.000Z");

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
    opts.currentLevel ?? 2,
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
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-l2" });
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
        message_text: "Hey — no row yet. What's going on?",
        next_check_in_iso: "2026-05-12T10:05:00.000Z",
      },
    };
  };
  return { impl, calls };
}

describe("LEVEL_2_TEMPLATE", () => {
  it("exposes levelName, voiceRules, and outputSchema", () => {
    expect(LEVEL_2_TEMPLATE.levelName).toBe("L2");
    expect(typeof LEVEL_2_TEMPLATE.voiceRules).toBe("string");
    expect(LEVEL_2_TEMPLATE.voiceRules.length).toBeGreaterThan(0);
    expect(typeof LEVEL_2_TEMPLATE.outputSchema).toBe("string");
    expect(LEVEL_2_TEMPLATE.outputSchema.length).toBeGreaterThan(0);
  });

  it("voice rules describe a curious, not-loaded tone", () => {
    expect(LEVEL_2_TEMPLATE.voiceRules.toLowerCase()).toContain("curious");
  });

  it("voice rules forbid WHY content (stakes / body data / patterns)", () => {
    const rules = LEVEL_2_TEMPLATE.voiceRules.toLowerCase();
    // The template MUST explicitly instruct the model not to use WHY material.
    expect(rules).toMatch(/no why/i);
  });

  it("output schema parses as JSON with message_text and next_check_in_iso", () => {
    const parsed = JSON.parse(LEVEL_2_TEMPLATE.outputSchema) as {
      properties?: Record<string, unknown>;
    };
    expect(parsed.properties).toBeDefined();
    expect(parsed.properties!["message_text"]).toBeDefined();
    expect(parsed.properties!["next_check_in_iso"]).toBeDefined();
  });
});

describe("runHabitCheckin() at L2", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkin-l2-"));
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

  it("morning-row L2: dispatches with L2 voice rules, advances level to 3, next_escalation_at = now + 30 min", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l2",
      habitId: "morning-row",
      currentLevel: 2,
    });
    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l2",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    // Prompt must mention the L2 level (header from prompt-builder).
    expect(calls[0]!.prompt).toContain("L2");
    // L2 voice rules must specify curious tone.
    expect(calls[0]!.prompt.toLowerCase()).toContain("curious");

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["morning-row"]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArg = mockSend.mock.calls[0]![0] as { content: string };
    expect(sendArg.content).toBe("Hey — no row yet. What's going on?");

    const row = getRun(db, "run-mr-l2");
    expect(row?.current_level).toBe(3);
    expect(row?.next_escalation_at).toBe(NOW_MS + 30 * 60 * 1000);

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("habit_prompt_sent");

    expect(result).toEqual({
      dispatched: true,
      messagePosted: true,
      newLevel: 3,
      nextEscalationAt: NOW_MS + 30 * 60 * 1000,
      calloutFired: false,
    });
  });

  it("wind-down L2: next_escalation_at = now + 5 min, posts to wind-down channel", async () => {
    seedHabitRun(db, {
      runId: "run-wd-l2",
      habitId: "wind-down",
      currentLevel: 2,
    });
    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-wd-l2",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["wind-down"]);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const row = getRun(db, "run-wd-l2");
    expect(row?.current_level).toBe(3);
    expect(row?.next_escalation_at).toBe(NOW_MS + 5 * 60 * 1000);

    expect(result.nextEscalationAt).toBe(NOW_MS + 5 * 60 * 1000);
  });

  it("strength-mwf L2: 30 min cadence, posts to strength channel", async () => {
    seedHabitRun(db, {
      runId: "run-st-l2",
      habitId: "strength-mwf",
      currentLevel: 2,
    });
    const { adapter, mockFetch } = buildAdapter();
    const { impl } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-st-l2",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS.strength);
    const row = getRun(db, "run-st-l2");
    expect(row?.current_level).toBe(3);
    expect(row?.next_escalation_at).toBe(NOW_MS + 30 * 60 * 1000);
  });

  it("L2 prompt does NOT include WHY content (stakes/body data/patterns)", async () => {
    seedHabitRun(db, {
      runId: "run-no-why",
      habitId: "morning-row",
      currentLevel: 2,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-no-why",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    // The voice-rules section of the prompt must forbid WHY content.
    // We assert the instruction (NOT the absence of stakes data — the
    // habit's why_stakes JSON is intentionally NOT injected at L1/L2 per
    // design § 3; the WHY wells fire at L3/L4).
    const promptLower = calls[0]!.prompt.toLowerCase();
    expect(promptLower).toMatch(/no why/i);
    // Sanity: voice rules should not narratively name stakes/HRV/sleep
    // metrics as content the model should reference.
    expect(promptLower).not.toContain("stakes_well");
  });

  it("L2 with rejection callout: prompt contains callout, flag resets to 0, calloutFired=true", async () => {
    seedHabitRun(db, {
      runId: "run-l2-cb",
      habitId: "strength-mwf",
      currentLevel: 2,
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-l2-cb",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain("CALLOUT:");
    expect(calls[0]!.prompt).toContain("training_log");

    const row = getRun(db, "run-l2-cb");
    expect(row?.proof_rejection_callout_due).toBe(0);
    expect(result.calloutFired).toBe(true);
  });

  it("L2 schema validation failure (missing message_text): no DB writes, throws", async () => {
    seedHabitRun(db, {
      runId: "run-l2-bad-schema",
      habitId: "morning-row",
      currentLevel: 2,
    });
    const { adapter, mockSend } = buildAdapter();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-l2-bad-schema",
        currentLevel: 2,
        now: NOW_MS,
        dispatchImpl: async () => ({
          structured_output: { next_check_in_iso: "2026-05-12T10:05:00.000Z" },
        }),
      }),
    ).rejects.toThrowError();

    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-l2-bad-schema");
    expect(row?.current_level).toBe(2);
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("L2 dispatch failure: no DB writes, throws", async () => {
    seedHabitRun(db, {
      runId: "run-l2-disp-fail",
      habitId: "morning-row",
      currentLevel: 2,
    });
    const { adapter, mockSend } = buildAdapter();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-l2-disp-fail",
        currentLevel: 2,
        now: NOW_MS,
        dispatchImpl: async () => ({ error: "subprocess timeout" }),
      }),
    ).rejects.toThrowError(/dispatch/i);

    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-l2-disp-fail");
    expect(row?.current_level).toBe(2);
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("L2 event payload: contains habitId, runId, level=2, messageText, calloutFired", async () => {
    seedHabitRun(db, {
      runId: "run-l2-evt",
      habitId: "morning-row",
      currentLevel: 2,
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-l2-evt",
      currentLevel: 2,
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
    expect(payload.runId).toBe("run-l2-evt");
    expect(payload.level).toBe(2);
    expect(payload.messageText).toContain("no row yet");
    expect(payload.calloutFired).toBe(true);
    expect(events[0].trust_level).toBe("L1");
  });
});
