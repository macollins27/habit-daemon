// Task 30: tests for runHabitCheckin() at L4 — the direct callout.
//
// L4 is the fourth (and, for morning-row / strength-mwf, penultimate) step.
// The voice is direct callout only: name the lateness, name the silence —
// but NO new WHY content. The WHY was deployed at L3; L4 must NOT introduce
// new stakes / body data / pattern content. Same output schema as L1/L2 (one
// message_text + one next_check_in_iso). Same DI seams (dispatchImpl,
// postImpl) and same atomicity guarantees (dispatch + post happen BEFORE the
// DB transaction; all SQLite writes go through one better-sqlite3
// transaction).
//
// wind-down has NO L4→L5 transition per design § 3 — the window closes at
// L4 — so calling the verb with currentLevel=4 for wind-down must throw
// (getEscalationDeltaMinutes throws for wind-down fromLevel=4). Task 37
// owns the actual wind-down terminal state evaluation.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 30
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 ("Direct callout
//     only. No new WHY content.")
//   - src/orchestrate/habit-checkin.ts (verb under test)
//   - src/lib/prompt-templates/level-4.ts (LEVEL_4_TEMPLATE)

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
import { LEVEL_4_TEMPLATE } from "../../src/lib/prompt-templates/level-4.js";

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

const SESSION_ID = "session-test-l4-0001";
const FIRE_DATE = "2026-05-12";
// L4 fires 30 minutes after L3 for morning-row / strength-mwf. wind-down
// has no L4→L5 transition. The verb computes next_escalation_at off the
// injected `now`, so the exact fired_at vs now offset doesn't matter for
// these tests.
const NOW_MS = Date.parse("2026-05-12T10:35:00.000Z");

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
    opts.currentLevel ?? 4,
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
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-l4" });
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
        message_text:
          "Max. 90 minutes past. What's actually blocking you right now?",
        next_check_in_iso: "2026-05-12T11:05:00.000Z",
      },
    };
  };
  return { impl, calls };
}

describe("LEVEL_4_TEMPLATE", () => {
  it("exposes levelName, voiceRules, and outputSchema", () => {
    expect(LEVEL_4_TEMPLATE.levelName).toBe("L4");
    expect(typeof LEVEL_4_TEMPLATE.voiceRules).toBe("string");
    expect(LEVEL_4_TEMPLATE.voiceRules.length).toBeGreaterThan(0);
    expect(typeof LEVEL_4_TEMPLATE.outputSchema).toBe("string");
    expect(LEVEL_4_TEMPLATE.outputSchema.length).toBeGreaterThan(0);
  });

  it("voice rules describe a direct callout tone", () => {
    expect(LEVEL_4_TEMPLATE.voiceRules.toLowerCase()).toContain(
      "direct callout",
    );
  });

  it("voice rules forbid new WHY content (the WHY was deployed at L3)", () => {
    const rules = LEVEL_4_TEMPLATE.voiceRules.toLowerCase();
    // The template MUST explicitly instruct the model not to introduce
    // new WHY material at L4 (stakes / body data / patterns belong to L3).
    expect(rules).toMatch(/no new why/i);
  });

  it("output schema parses as JSON with message_text and next_check_in_iso", () => {
    const parsed = JSON.parse(LEVEL_4_TEMPLATE.outputSchema) as {
      properties?: Record<string, unknown>;
    };
    expect(parsed.properties).toBeDefined();
    expect(parsed.properties!["message_text"]).toBeDefined();
    expect(parsed.properties!["next_check_in_iso"]).toBeDefined();
  });
});

describe("runHabitCheckin() at L4", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkin-l4-"));
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

  it("morning-row L4: dispatches with L4 voice rules, advances level to 5, next_escalation_at = now + 30 min", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l4",
      habitId: "morning-row",
      currentLevel: 4,
    });
    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l4",
      currentLevel: 4,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    // Prompt must mention the L4 level (header from prompt-builder).
    expect(calls[0]!.prompt).toContain("L4");
    // L4 voice rules must specify direct callout tone.
    expect(calls[0]!.prompt.toLowerCase()).toContain("direct callout");

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["morning-row"]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArg = mockSend.mock.calls[0]![0] as { content: string };
    expect(sendArg.content).toBe(
      "Max. 90 minutes past. What's actually blocking you right now?",
    );

    const row = getRun(db, "run-mr-l4");
    expect(row?.current_level).toBe(5);
    expect(row?.next_escalation_at).toBe(NOW_MS + 30 * 60 * 1000);

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("habit_prompt_sent");

    expect(result).toEqual({
      dispatched: true,
      messagePosted: true,
      newLevel: 5,
      nextEscalationAt: NOW_MS + 30 * 60 * 1000,
      calloutFired: false,
    });
  });

  it("strength-mwf L4: 30 min cadence, posts to strength channel", async () => {
    seedHabitRun(db, {
      runId: "run-st-l4",
      habitId: "strength-mwf",
      currentLevel: 4,
    });
    const { adapter, mockFetch } = buildAdapter();
    const { impl } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-st-l4",
      currentLevel: 4,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS.strength);
    const row = getRun(db, "run-st-l4");
    expect(row?.current_level).toBe(5);
    expect(row?.next_escalation_at).toBe(NOW_MS + 30 * 60 * 1000);
  });

  it("wind-down L4 is TERMINAL: dispatches the final message then closes the run (status='missed')", async () => {
    // L4 is wind-down's terminal level (design § 3: the window closes at L4).
    // Its escalation chain L1→L2→L3→L4 ends here, so L4 mirrors L5 for the
    // other habits: dispatch the final message, then close. Previously the
    // verb threw at the getEscalationDeltaMinutes gap, which in production made
    // the scheduler re-fire the run every tick forever (incident 2026-06-02).
    seedHabitRun(db, {
      runId: "run-wd-l4",
      habitId: "wind-down",
      currentLevel: 4,
    });
    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-wd-l4",
      currentLevel: 4,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    // Final message dispatched + posted to the wind-down channel.
    expect(calls.length).toBe(1);
    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["wind-down"]);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Terminal transition: no level advance, no further escalation, missed.
    const row = getRun(db, "run-wd-l4");
    expect(row?.current_level).toBe(4);
    expect(row?.next_escalation_at).toBeNull();
    expect(row?.status).toBe("missed");

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0].event_json) as {
      level: number;
      terminal: boolean;
    };
    expect(payload.level).toBe(4);
    expect(payload.terminal).toBe(true);

    expect(result).toEqual({
      dispatched: true,
      messagePosted: true,
      newLevel: 4,
      nextEscalationAt: null,
      calloutFired: false,
    });
  });

  it("L4 prompt does NOT include new WHY content (no stakes / body data / patterns)", async () => {
    seedHabitRun(db, {
      runId: "run-l4-no-why",
      habitId: "morning-row",
      currentLevel: 4,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-l4-no-why",
      currentLevel: 4,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    const promptLower = calls[0]!.prompt.toLowerCase();
    // The voice-rules section of the prompt MUST explicitly forbid
    // introducing new WHY content at L4.
    expect(promptLower).toMatch(/no new why/i);
    // Sanity: voice rules should not narratively name the WHY wells as
    // content the L4 model should reference.
    expect(promptLower).not.toContain("stakes_well");
  });

  it("L4 with rejection callout: prompt contains CALLOUT, flag resets to 0, calloutFired=true", async () => {
    seedHabitRun(db, {
      runId: "run-l4-cb",
      habitId: "strength-mwf",
      currentLevel: 4,
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-l4-cb",
      currentLevel: 4,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain("CALLOUT:");
    expect(calls[0]!.prompt).toContain("training_log");

    const row = getRun(db, "run-l4-cb");
    expect(row?.proof_rejection_callout_due).toBe(0);
    expect(result.calloutFired).toBe(true);
  });

  it("L4 schema validation failure (missing message_text): no DB writes, throws", async () => {
    seedHabitRun(db, {
      runId: "run-l4-bad-schema",
      habitId: "morning-row",
      currentLevel: 4,
    });
    const { adapter, mockSend } = buildAdapter();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-l4-bad-schema",
        currentLevel: 4,
        now: NOW_MS,
        dispatchImpl: async () => ({
          structured_output: { next_check_in_iso: "2026-05-12T11:05:00.000Z" },
        }),
      }),
    ).rejects.toThrowError();

    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-l4-bad-schema");
    expect(row?.current_level).toBe(4);
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("L4 dispatch failure: no DB writes, throws", async () => {
    seedHabitRun(db, {
      runId: "run-l4-disp-fail",
      habitId: "morning-row",
      currentLevel: 4,
    });
    const { adapter, mockSend } = buildAdapter();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-l4-disp-fail",
        currentLevel: 4,
        now: NOW_MS,
        dispatchImpl: async () => ({ error: "subprocess timeout" }),
      }),
    ).rejects.toThrowError(/dispatch/i);

    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-l4-disp-fail");
    expect(row?.current_level).toBe(4);
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("L4 event payload: contains habitId, runId, level=4, messageText, calloutFired (no well/stake fields)", async () => {
    seedHabitRun(db, {
      runId: "run-l4-evt",
      habitId: "morning-row",
      currentLevel: 4,
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-l4-evt",
      currentLevel: 4,
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
      well?: string;
      stake?: string;
    };
    expect(payload.habitId).toBe("morning-row");
    expect(payload.runId).toBe("run-l4-evt");
    expect(payload.level).toBe(4);
    expect(payload.messageText).toContain("blocking you");
    expect(payload.calloutFired).toBe(true);
    expect(events[0].trust_level).toBe("L1");
    // L4 does NOT consult the WHY-well selector — the payload must not
    // carry `well` / `stake` / `anomalousSignals` / `slugPrefix`.
    expect(payload.well).toBeUndefined();
    expect(payload.stake).toBeUndefined();
  });
});
