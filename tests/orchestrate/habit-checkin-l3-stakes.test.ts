// Task 27: tests for runHabitCheckin() at L3 with the stakes_well payload.
//
// L3 is the "WHY hammer" — the first escalation step that actually deploys
// the user's pre-committed motivation context. The selector (Task 26) returns
// one of three payloads: pattern | body_data | stakes; Task 27 wires only the
// stakes branch. The other two branches are expected to throw with a clear
// "not yet wired" message that points at the future task that will land them.
//
// What L3 stakes adds on top of L1/L2:
//   - The verb loads selector context (trailing miss_reasons + sensor_signals
//     + the last-pattern/last-stakes use stamps mined from session_events).
//   - It calls selectWell() to pick a payload.
//   - It builds the L3 stakes prompt template parameterised by the chosen
//     stake text (primary | secondary | tertiary).
//   - It records `well` + `stake` in the habit_prompt_sent event payload so
//     the next L3 dispatch can find the prior usage and rotate.
//
// The 7-day dedup window is the rotation rule: use the same stake within
// `< 7 days`; rotate to the next one at `>= 7 days` since last use; wrap
// tertiary → primary.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 27
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (L3 WHY-well rotation)
//   - src/lib/why-well-selector.ts (selectWell — pure picker)
//   - src/lib/prompt-templates/level-3-stakes.ts (template under test)
//   - src/orchestrate/habit-checkin.ts (verb under test)

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
import { buildRecord } from "../../src/daemon/aat-chain.js";
import {
  createDiscordAdapter,
  type DiscordAdapter,
  type DiscordChannelIds,
} from "../../src/lib/discord-adapter.js";
import { runHabitCheckin } from "../../src/orchestrate/habit-checkin.js";
import { buildL3StakesTemplate } from "../../src/lib/prompt-templates/level-3-stakes.js";

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

const SESSION_ID = "session-test-l3-0001";
const FIRE_DATE = "2026-05-12";
const NOW_MS = Date.parse("2026-05-12T10:05:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// The three locked Phase A stakes (verbatim from src/db/seed-habits.ts).
const STAKE_PRIMARY =
  "12 months post T9-T12 compression fracture, recovery stalled";
const STAKE_SECONDARY =
  "Family livelihood depends on Linkware shipping — body has to last the build";
const STAKE_TERTIARY =
  "Detrained athlete (former top-3 triathlon) trying to restore baseline";

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
    opts.currentLevel ?? 3,
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

interface LastEventRow {
  readonly seq: number;
  readonly hash: string;
}

/**
 * Insert a synthetic `habit_prompt_sent` event whose payload carries
 * `well`/`stake` and whose `written_iso` is back-dated to `usedAtMs`. We
 * cannot go through SessionStore.append() because it auto-stamps
 * `writtenIso = new Date().toISOString()` and the table's BEFORE UPDATE
 * trigger forbids in-place edits. Instead we replicate append()'s
 * hash-chain semantics via `buildRecord` and INSERT directly with a
 * controlled `written_iso`.
 */
function seedPriorStakesEvent(
  store: SessionStore,
  sessionId: string,
  habitId: string,
  stake: "primary" | "secondary" | "tertiary",
  usedAtMs: number,
): void {
  store.createSession(sessionId);
  const last = store.db
    .prepare(
      `SELECT seq, hash FROM session_events
        WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(sessionId) as LastEventRow | undefined;
  const seq = (last?.seq ?? -1) + 1;
  const prevHash = last?.hash ?? null;
  const record = buildRecord({
    seq,
    event: {
      habitId,
      runId: `run-prior-${stake}`,
      level: 3,
      messageText: `prior ${stake} L3 prompt`,
      calloutFired: false,
      well: "stakes",
      stake,
    },
    prevHash,
    trustLevel: "L1",
  });
  store.db
    .prepare(
      `INSERT INTO session_events
         (session_id, seq, event_json, prev_hash, hash, trust_level, event_type, written_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      record.seq,
      record.eventJson,
      record.prevHash,
      record.hash,
      record.trustLevel,
      "habit_prompt_sent",
      new Date(usedAtMs).toISOString(),
    );
}

interface BuildAdapterResult {
  readonly adapter: DiscordAdapter;
  readonly mockSend: ReturnType<typeof vi.fn>;
  readonly mockFetch: ReturnType<typeof vi.fn>;
}

function buildAdapter(): BuildAdapterResult {
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-l3" });
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
          "Max — 12 months post-fracture. The row IS the recovery. Where are we at?",
        next_check_in_iso: "2026-05-12T10:35:00.000Z",
      },
    };
  };
  return { impl, calls };
}

// ----------------------------------------------------------------------------
// Template smoke tests (pure unit, no DB)
// ----------------------------------------------------------------------------

describe("buildL3StakesTemplate()", () => {
  it("returns levelName 'L3'", () => {
    const tpl = buildL3StakesTemplate({
      well: "stakes",
      stake: "primary",
      text: "STAKE_TEXT",
    });
    expect(tpl.levelName).toBe("L3");
  });

  it("interpolates the stake text into the voice rules", () => {
    const tpl = buildL3StakesTemplate({
      well: "stakes",
      stake: "secondary",
      text: "MY_TEST_STAKE_TEXT",
    });
    expect(tpl.voiceRules).toContain("MY_TEST_STAKE_TEXT");
    expect(tpl.voiceRules).toContain("secondary");
  });

  it("voice rules forbid generic pep-talk content", () => {
    const tpl = buildL3StakesTemplate({
      well: "stakes",
      stake: "primary",
      text: "X",
    });
    // The template must steer the model away from generic motivational
    // material — it must deploy the named stake, not lecture about habits.
    const rules = tpl.voiceRules.toLowerCase();
    expect(rules).toMatch(/lecture|pep talk|moralize|moralise|motivational/);
  });

  it("output schema parses as JSON with message_text + next_check_in_iso", () => {
    const tpl = buildL3StakesTemplate({
      well: "stakes",
      stake: "tertiary",
      text: "X",
    });
    const parsed = JSON.parse(tpl.outputSchema) as {
      properties?: Record<string, unknown>;
    };
    expect(parsed.properties).toBeDefined();
    expect(parsed.properties!["message_text"]).toBeDefined();
    expect(parsed.properties!["next_check_in_iso"]).toBeDefined();
  });
});

// ----------------------------------------------------------------------------
// Verb-level integration tests
// ----------------------------------------------------------------------------

describe("runHabitCheckin() at L3 — stakes_well rotation", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkin-l3-"));
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

  it("happy path morning-row L3: no prior stakes use → primary stake, level→4, next_escalation_at = now + 30 min, event has well+stake", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l3",
      habitId: "morning-row",
      currentLevel: 3,
    });
    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toContain("L3");
    expect(calls[0]!.prompt).toContain(STAKE_PRIMARY);

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["morning-row"]);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const row = getRun(db, "run-mr-l3");
    expect(row?.current_level).toBe(4);
    expect(row?.next_escalation_at).toBe(NOW_MS + 30 * 60 * 1000);

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("habit_prompt_sent");
    const payload = JSON.parse(events[0].event_json) as {
      habitId: string;
      runId: string;
      level: number;
      well: string;
      stake: string;
    };
    expect(payload.well).toBe("stakes");
    expect(payload.stake).toBe("primary");
    expect(payload.level).toBe(3);

    expect(result).toEqual({
      dispatched: true,
      messagePosted: true,
      newLevel: 4,
      nextEscalationAt: NOW_MS + 30 * 60 * 1000,
      calloutFired: false,
    });
  });

  it("L3 stakes rotation: primary used 8 days ago → returns secondary", async () => {
    seedPriorStakesEvent(
      sessionStore,
      SESSION_ID,
      "morning-row",
      "primary",
      NOW_MS - 8 * DAY_MS,
    );
    seedHabitRun(db, {
      runId: "run-mr-l3-rot1",
      habitId: "morning-row",
      currentLevel: 3,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-rot1",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain(STAKE_SECONDARY);
    expect(calls[0]!.prompt).not.toContain(STAKE_PRIMARY);

    const events = getSessionEvents(db, SESSION_ID);
    // 1 seeded + 1 from this dispatch = 2 total.
    expect(events.length).toBe(2);
    const newest = events[events.length - 1]!;
    const payload = JSON.parse(newest.event_json) as { stake: string };
    expect(payload.stake).toBe("secondary");
  });

  it("L3 stakes dedup: primary used 1 day ago → still primary (inside dedup window)", async () => {
    seedPriorStakesEvent(
      sessionStore,
      SESSION_ID,
      "morning-row",
      "primary",
      NOW_MS - 1 * DAY_MS,
    );
    seedHabitRun(db, {
      runId: "run-mr-l3-dd1",
      habitId: "morning-row",
      currentLevel: 3,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-dd1",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain(STAKE_PRIMARY);
    expect(calls[0]!.prompt).not.toContain(STAKE_SECONDARY);

    const events = getSessionEvents(db, SESSION_ID);
    const newest = events[events.length - 1]!;
    const payload = JSON.parse(newest.event_json) as { stake: string };
    expect(payload.stake).toBe("primary");
  });

  it("L3 stakes dedup boundary: primary used 6 days ago → still primary (dedup window is 7 days)", async () => {
    seedPriorStakesEvent(
      sessionStore,
      SESSION_ID,
      "morning-row",
      "primary",
      NOW_MS - 6 * DAY_MS,
    );
    seedHabitRun(db, {
      runId: "run-mr-l3-dd6",
      habitId: "morning-row",
      currentLevel: 3,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-dd6",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain(STAKE_PRIMARY);
  });

  it("L3 stakes rotation: secondary used 7 days ago → tertiary", async () => {
    seedPriorStakesEvent(
      sessionStore,
      SESSION_ID,
      "morning-row",
      "secondary",
      NOW_MS - 7 * DAY_MS,
    );
    seedHabitRun(db, {
      runId: "run-mr-l3-rot2",
      habitId: "morning-row",
      currentLevel: 3,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-rot2",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain(STAKE_TERTIARY);

    const events = getSessionEvents(db, SESSION_ID);
    const newest = events[events.length - 1]!;
    const payload = JSON.parse(newest.event_json) as { stake: string };
    expect(payload.stake).toBe("tertiary");
  });

  it("L3 stakes rotation wrap: tertiary used 7+ days ago → primary", async () => {
    seedPriorStakesEvent(
      sessionStore,
      SESSION_ID,
      "morning-row",
      "tertiary",
      NOW_MS - 10 * DAY_MS,
    );
    seedHabitRun(db, {
      runId: "run-mr-l3-wrap",
      habitId: "morning-row",
      currentLevel: 3,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-wrap",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain(STAKE_PRIMARY);

    const events = getSessionEvents(db, SESSION_ID);
    const newest = events[events.length - 1]!;
    const payload = JSON.parse(newest.event_json) as { stake: string };
    expect(payload.stake).toBe("primary");
  });

  // Task 29 removed the "pattern throws" test from this file; the
  // pattern_well branch now dispatches successfully and is exercised end to
  // end in tests/orchestrate/habit-checkin-l3-pattern.test.ts.

  it("wind-down L3: next_escalation_at = now + 2 min", async () => {
    seedHabitRun(db, {
      runId: "run-wd-l3",
      habitId: "wind-down",
      currentLevel: 3,
    });
    const { adapter, mockFetch } = buildAdapter();
    const { impl } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-wd-l3",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["wind-down"]);
    const row = getRun(db, "run-wd-l3");
    expect(row?.current_level).toBe(4);
    expect(row?.next_escalation_at).toBe(NOW_MS + 2 * 60 * 1000);
    expect(result.nextEscalationAt).toBe(NOW_MS + 2 * 60 * 1000);
  });

  it("L3 schema validation failure: dispatch returns malformed structured_output → throws + no DB writes", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l3-badschema",
      habitId: "morning-row",
      currentLevel: 3,
    });
    const { adapter, mockSend } = buildAdapter();
    const eventsBefore = countEvents(db);

    await expect(
      runHabitCheckin({
        sessionStore,
        adapter,
        sessionId: SESSION_ID,
        runId: "run-mr-l3-badschema",
        currentLevel: 3,
        now: NOW_MS,
        dispatchImpl: async () => ({
          structured_output: { next_check_in_iso: "2026-05-12T10:35:00.000Z" },
        }),
      }),
    ).rejects.toThrowError();

    expect(mockSend).not.toHaveBeenCalled();
    const row = getRun(db, "run-mr-l3-badschema");
    expect(row?.current_level).toBe(3);
    expect(row?.next_escalation_at).toBeNull();
    expect(countEvents(db)).toBe(eventsBefore);
  });

  it("L3 with rejection callout: prompt contains CALLOUT block, flag resets to 0", async () => {
    seedHabitRun(db, {
      runId: "run-st-l3-cb",
      habitId: "strength-mwf",
      currentLevel: 3,
      calloutDue: 1,
    });
    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-st-l3-cb",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain("CALLOUT:");
    expect(calls[0]!.prompt).toContain("training_log");
    // The stake content is still there too (L3 layers stake onto callout).
    expect(calls[0]!.prompt).toContain(STAKE_PRIMARY);

    const row = getRun(db, "run-st-l3-cb");
    expect(row?.proof_rejection_callout_due).toBe(0);
    expect(result.calloutFired).toBe(true);
  });
});
