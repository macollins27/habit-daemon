// Task 31: tests for runHabitCheckin() at L5 — the terminal "logged as
// missed" message.
//
// L5 is the TERMINAL escalation step for morning-row / strength-mwf. The
// voice rules instruct a brief, factual closure ("Logged as missed. We'll
// talk tomorrow."), with NO new WHY content (the WHY was deployed at L3,
// called out at L4) and no future-tense continuation (the next conversation
// is the Phase B post-miss interview, not another check-in).
//
// What makes L5 different from L1-L4:
//   1. The DB transition is terminal:
//        - status flips from 'pending' to 'missed'
//        - next_escalation_at = NULL
//        - current_level stays at 5 (no advance — terminal)
//   2. The cadence lookup (getEscalationDeltaMinutes) is SKIPPED. There is
//      no L5→L6 entry in the per-habit cadence table; querying it would
//      throw. The verb special-cases L5 before the lookup.
//   3. The event payload carries `terminal: true` so downstream queries
//      (Phase B post-miss interview, Sunday review) can find the terminal
//      event without re-walking the chain.
//
// wind-down has NO L5 per design § 3 — the window closes at L4 — so
// calling the verb with currentLevel=5 for wind-down must throw with no
// side effects (fail-fast, before dispatch / post / DB writes).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 31
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 ("L5 posts final
//     message, sets status='missed', halts.")
//   - src/orchestrate/habit-checkin.ts (verb under test)
//   - src/lib/prompt-templates/level-5.ts (LEVEL_5_TEMPLATE)

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
import { LEVEL_5_TEMPLATE } from "../../src/lib/prompt-templates/level-5.js";

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

const SESSION_ID = "session-test-l5-0001";
const FIRE_DATE = "2026-05-12";
// L5 fires 30 minutes after L4 for morning-row / strength-mwf (11:05 for
// the canonical morning-row schedule). The verb does not consult cadence
// at L5 so the exact `now` value only matters as a reference point for the
// session_events row's `written_iso`.
const NOW_MS = Date.parse("2026-05-12T11:05:00.000Z");

function seedHabitRun(
  db: Database.Database,
  opts: {
    runId: string;
    habitId: string;
    currentLevel?: number;
    calloutDue?: 0 | 1;
    firedAt?: number;
    status?: string;
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
    opts.currentLevel ?? 5,
    null,
    opts.status ?? "pending",
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
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-l5" });
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
        message_text: "Logged as missed. We'll talk tomorrow.",
        // L5 has no next escalation; the model's suggested iso is ignored
        // by the verb. Including a placeholder so the shared schema parses.
        next_check_in_iso: "2026-05-13T08:30:00.000Z",
      },
    };
  };
  return { impl, calls };
}

describe("LEVEL_5_TEMPLATE", () => {
  it("exposes levelName, voiceRules, and outputSchema", () => {
    expect(LEVEL_5_TEMPLATE.levelName).toBe("L5");
    expect(typeof LEVEL_5_TEMPLATE.voiceRules).toBe("string");
    expect(LEVEL_5_TEMPLATE.voiceRules.length).toBeGreaterThan(0);
    expect(typeof LEVEL_5_TEMPLATE.outputSchema).toBe("string");
    expect(LEVEL_5_TEMPLATE.outputSchema.length).toBeGreaterThan(0);
  });

  it("voice rules describe a terminal / final / closure message", () => {
    // The voice rules MUST signal to the model that this is the last
    // message of the run. We accept any of the closure-vocabulary terms
    // (final, terminal, last, closure) so the wording is allowed to
    // evolve without making the test brittle to phrasing.
    const rules = LEVEL_5_TEMPLATE.voiceRules.toLowerCase();
    expect(rules).toMatch(/final|terminal|last message|closure/);
  });

  it("voice rules forbid new WHY content (WHY was deployed at L3, called out at L4)", () => {
    const rules = LEVEL_5_TEMPLATE.voiceRules.toLowerCase();
    expect(rules).toMatch(/no new why/i);
  });

  it("output schema parses as JSON with message_text and next_check_in_iso", () => {
    const parsed = JSON.parse(LEVEL_5_TEMPLATE.outputSchema) as {
      properties?: Record<string, unknown>;
    };
    expect(parsed.properties).toBeDefined();
    expect(parsed.properties!["message_text"]).toBeDefined();
    expect(parsed.properties!["next_check_in_iso"]).toBeDefined();
  });
});

describe("runHabitCheckin() at L5", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkin-l5-"));
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

  it("morning-row L5: terminal transition — status='missed', next_escalation_at=NULL, current_level stays at 5", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l5",
      habitId: "morning-row",
      currentLevel: 5,
    });
    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l5",
      currentLevel: 5,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    // Prompt must mention the L5 level (header from prompt-builder).
    expect(calls[0]!.prompt).toContain("L5");
    // L5 voice rules must signal closure / final.
    expect(calls[0]!.prompt.toLowerCase()).toMatch(
      /final|terminal|last message|closure/,
    );

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["morning-row"]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArg = mockSend.mock.calls[0]![0] as { content: string };
    expect(sendArg.content).toBe("Logged as missed. We'll talk tomorrow.");

    const row = getRun(db, "run-mr-l5");
    expect(row?.current_level).toBe(5);
    expect(row?.next_escalation_at).toBeNull();
    expect(row?.status).toBe("missed");

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("habit_prompt_sent");
    const payload = JSON.parse(events[0].event_json) as {
      habitId: string;
      runId: string;
      level: number;
      messageText: string;
      calloutFired: boolean;
      terminal: boolean;
    };
    expect(payload.level).toBe(5);
    expect(payload.terminal).toBe(true);

    expect(result).toEqual({
      dispatched: true,
      messagePosted: true,
      newLevel: 5,
      nextEscalationAt: null,
      calloutFired: false,
    });
  });

  it("strength-mwf L5: terminal transition, posts to strength channel", async () => {
    seedHabitRun(db, {
      runId: "run-st-l5",
      habitId: "strength-mwf",
      currentLevel: 5,
    });
    const { adapter, mockFetch } = buildAdapter();
    const { impl } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-st-l5",
      currentLevel: 5,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS.strength);
    const row = getRun(db, "run-st-l5");
    expect(row?.current_level).toBe(5);
    expect(row?.next_escalation_at).toBeNull();
    expect(row?.status).toBe("missed");
  });

  it("wind-down L5: throws (wind-down terminates at L4), no dispatch, no post, no DB writes", async () => {
    seedHabitRun(db, {
      runId: "run-wd-l5",
      habitId: "wind-down",
      currentLevel: 5,
    });
    const { adapter, mockSend } = buildAdapter();
    const { impl, calls } = happyDispatch();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-wd-l5",
        currentLevel: 5,
        now: NOW_MS,
        dispatchImpl: impl,
      }),
    ).rejects.toThrowError();

    // Fail-fast contract: the verb must reject wind-down L5 BEFORE dispatch
    // and BEFORE the Discord post. wind-down has no L5 per design § 3.
    expect(calls.length).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-wd-l5");
    expect(row?.current_level).toBe(5);
    expect(row?.status).toBe("pending");
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("L5 with rejection callout: prompt contains CALLOUT, flag resets to 0, calloutFired=true", async () => {
    seedHabitRun(db, {
      runId: "run-l5-cb",
      habitId: "morning-row",
      currentLevel: 5,
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-l5-cb",
      currentLevel: 5,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain("CALLOUT:");

    const row = getRun(db, "run-l5-cb");
    // Even on terminal L5, the rejection-callout flag must reset to 0
    // so it does not bleed into the post-miss interview's context.
    expect(row?.proof_rejection_callout_due).toBe(0);
    // Terminal status must still be applied.
    expect(row?.status).toBe("missed");
    expect(row?.next_escalation_at).toBeNull();
    expect(result.calloutFired).toBe(true);
  });

  it("L5 dispatch failure: no DB writes, throws, status stays 'pending'", async () => {
    seedHabitRun(db, {
      runId: "run-l5-disp-fail",
      habitId: "morning-row",
      currentLevel: 5,
    });
    const { adapter, mockSend } = buildAdapter();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-l5-disp-fail",
        currentLevel: 5,
        now: NOW_MS,
        dispatchImpl: async () => ({ error: "subprocess timeout" }),
      }),
    ).rejects.toThrowError(/dispatch/i);

    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-l5-disp-fail");
    // Atomicity: if dispatch fails, the terminal transition must NOT
    // happen. status stays 'pending' so the scheduler can retry.
    expect(row?.current_level).toBe(5);
    expect(row?.status).toBe("pending");
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("L5 post failure: no DB writes, throws, status stays 'pending'", async () => {
    seedHabitRun(db, {
      runId: "run-l5-post-fail",
      habitId: "morning-row",
      currentLevel: 5,
    });

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
        runId: "run-l5-post-fail",
        currentLevel: 5,
        now: NOW_MS,
        dispatchImpl: impl,
      }),
    ).rejects.toThrowError();

    const row = getRun(db, "run-l5-post-fail");
    expect(row?.current_level).toBe(5);
    expect(row?.status).toBe("pending");
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("L5 event payload: contains habitId, runId, level=5, messageText, calloutFired, terminal=true", async () => {
    seedHabitRun(db, {
      runId: "run-l5-evt",
      habitId: "morning-row",
      currentLevel: 5,
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-l5-evt",
      currentLevel: 5,
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
      terminal: boolean;
      well?: string;
      stake?: string;
    };
    expect(payload.habitId).toBe("morning-row");
    expect(payload.runId).toBe("run-l5-evt");
    expect(payload.level).toBe(5);
    expect(payload.messageText).toContain("Logged as missed");
    expect(payload.calloutFired).toBe(true);
    expect(payload.terminal).toBe(true);
    expect(events[0].trust_level).toBe("L1");
    // L5 does NOT consult the WHY-well selector — the payload must not
    // carry `well` / `stake` / `anomalousSignals` / `slugPrefix`.
    expect(payload.well).toBeUndefined();
    expect(payload.stake).toBeUndefined();
  });
});
