// Task 29: tests for runHabitCheckin() at L3 with the pattern_well payload.
//
// L3 pattern fires when the trailing-28-day miss_reasons table holds 3+
// rows for THIS HABIT whose `inferred_specifics` share a slug prefix (the
// chunk before the first `:`). The selector (Task 26) picks pattern over
// body_data + stakes whenever the threshold trips AND the 14-day per-habit
// cooldown has expired. Task 29 wires the L3 pattern prompt template and
// the orchestration plumbing.
//
// What L3 pattern adds on top of L3 stakes (Task 27) and L3 body_data
// (Task 28):
//   - The verb threads `wellSelection.well === 'pattern'` into a dedicated
//     prompt template (level-3-pattern.ts) parameterised by the slug-prefix
//     + count + exemplar + the habit's framing template.
//   - It records `well: 'pattern'`, `slugPrefix`, and `patternCount` in the
//     habit_prompt_sent event payload so the next L3 invocation can find
//     this usage via json_extract (the 14-day cooldown check) and so
//     auditing/Sunday-review can read what fired.
//
// Phase A: miss_reasons is sparse — classification + slug minting that
// fills it lands in Phase B. The tests below force the pattern branch by
// seeding 3+ matching slug rows directly. The dormant no-op contract is
// verified separately in tests/lib/pattern-detector.test.ts.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 29
//   - src/lib/pattern-detector.ts (pure detector)
//   - src/lib/prompt-templates/level-3-pattern.ts (template under test)
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
import {
  createDiscordAdapter,
  type DiscordAdapter,
  type DiscordChannelIds,
} from "../../src/lib/discord-adapter.js";
import { runHabitCheckin } from "../../src/orchestrate/habit-checkin.js";
import { buildL3PatternTemplate } from "../../src/lib/prompt-templates/level-3-pattern.js";

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

const SESSION_ID = "session-test-l3-pattern-0001";
const FIRE_DATE = "2026-05-12";
const NOW_MS = Date.parse("2026-05-12T10:05:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function seedHabitRun(
  db: Database.Database,
  opts: {
    runId: string;
    habitId: string;
    currentLevel?: number;
    calloutDue?: 0 | 1;
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
    NOW_MS,
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

/**
 * Seed 3 prior habit_runs (the miss_reasons FK references habit_runs) plus
 * 3 same-slug miss_reasons inside the trailing 28-day window. After this,
 * the selector returns the pattern payload.
 */
function seedPatternRows(
  db: Database.Database,
  opts: {
    habitId: string;
    slug: string;
  },
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
      `prior-run-${i}`,
      opts.habitId,
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
      `mr-${i}`,
      opts.habitId,
      `prior-run-${i}`,
      priorDate,
      opts.slug,
      "gaming",
      priorMs,
    );
  }
}

interface BuildAdapterResult {
  readonly adapter: DiscordAdapter;
  readonly mockSend: ReturnType<typeof vi.fn>;
  readonly mockFetch: ReturnType<typeof vi.fn>;
}

function buildAdapter(): BuildAdapterResult {
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-l3-pattern" });
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
          "Third time in 28 days the row missed for the same reason. We figure out the actual block now, or it becomes the default.",
        next_check_in_iso: "2026-05-12T10:35:00.000Z",
      },
    };
  };
  return { impl, calls };
}

// ----------------------------------------------------------------------------
// Template smoke tests (pure unit, no DB)
// ----------------------------------------------------------------------------

describe("buildL3PatternTemplate()", () => {
  it("returns levelName 'L3'", () => {
    const tpl = buildL3PatternTemplate({
      well: "pattern",
      slugPrefix: "late-gaming-friend",
      count: 3,
      exemplarSpecifics: "late-gaming-friend:brian",
      framingTemplate: "TEST_FRAMING",
    });
    expect(tpl.levelName).toBe("L3");
  });

  it("interpolates the slug prefix, count, and exemplar into the voice rules", () => {
    const tpl = buildL3PatternTemplate({
      well: "pattern",
      slugPrefix: "MY_TEST_SLUG_PREFIX",
      count: 5,
      exemplarSpecifics: "MY_TEST_EXEMPLAR",
      framingTemplate: "X",
    });
    expect(tpl.voiceRules).toContain("MY_TEST_SLUG_PREFIX");
    expect(tpl.voiceRules).toContain("5");
    expect(tpl.voiceRules).toContain("MY_TEST_EXEMPLAR");
  });

  it("interpolates the framing template into the voice rules", () => {
    const tpl = buildL3PatternTemplate({
      well: "pattern",
      slugPrefix: "x",
      count: 3,
      exemplarSpecifics: "x:y",
      framingTemplate: "MY_TEST_FRAMING_TEMPLATE",
    });
    expect(tpl.voiceRules).toContain("MY_TEST_FRAMING_TEMPLATE");
  });

  it("voice rules forbid generic pep-talk / moralizing content", () => {
    const tpl = buildL3PatternTemplate({
      well: "pattern",
      slugPrefix: "x",
      count: 3,
      exemplarSpecifics: "x:y",
      framingTemplate: "X",
    });
    const rules = tpl.voiceRules.toLowerCase();
    expect(rules).toMatch(/lecture|pep talk|moralize|moralise|motivational/);
  });

  it("output schema parses as JSON with message_text + next_check_in_iso", () => {
    const tpl = buildL3PatternTemplate({
      well: "pattern",
      slugPrefix: "x",
      count: 3,
      exemplarSpecifics: "x:y",
      framingTemplate: "X",
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

describe("runHabitCheckin() at L3 — pattern_well", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkin-l3-pattern-"));
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

  it("dispatches L3 pattern prompt when 3+ same-slug miss_reasons exist; event payload carries well/slugPrefix/patternCount", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l3-pattern",
      habitId: "morning-row",
      currentLevel: 3,
    });
    seedPatternRows(db, {
      habitId: "morning-row",
      slug: "late-gaming-friend:brian",
    });

    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-pattern",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toContain("L3");
    // Pattern voice rules name the slug-prefix + count explicitly.
    expect(calls[0]!.prompt).toContain("late-gaming-friend");
    expect(calls[0]!.prompt).toContain("3");

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["morning-row"]);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const row = getRun(db, "run-mr-l3-pattern");
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
      slugPrefix: string;
      patternCount: number;
    };
    expect(payload.well).toBe("pattern");
    expect(payload.slugPrefix).toBe("late-gaming-friend");
    expect(payload.patternCount).toBe(3);
    expect(payload.level).toBe(3);

    expect(result.dispatched).toBe(true);
    expect(result.messagePosted).toBe(true);
    expect(result.newLevel).toBe(4);
  });

  it("L3 pattern with rejection callout: prompt contains CALLOUT block + pattern voice, flag resets to 0", async () => {
    seedHabitRun(db, {
      runId: "run-st-l3-pattern-cb",
      habitId: "strength-mwf",
      currentLevel: 3,
      calloutDue: 1,
    });
    seedPatternRows(db, {
      habitId: "strength-mwf",
      slug: "late-gaming-friend:brian",
    });

    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-st-l3-pattern-cb",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls[0]!.prompt).toContain("CALLOUT:");
    expect(calls[0]!.prompt).toContain("training_log");
    // The pattern content is still there too (L3 layers pattern onto callout).
    expect(calls[0]!.prompt).toContain("late-gaming-friend");

    const row = getRun(db, "run-st-l3-pattern-cb");
    expect(row?.proof_rejection_callout_due).toBe(0);
    expect(result.calloutFired).toBe(true);
  });

  it("falls back to stakes (does NOT dispatch pattern) when only 2 same-slug miss_reasons exist", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l3-too-few",
      habitId: "morning-row",
      currentLevel: 3,
    });
    // Seed only 2 matching miss_reasons — below the threshold of 3.
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
    for (let i = 0; i < 2; i += 1) {
      const priorMs = NOW_MS - (i + 1) * DAY_MS;
      const priorDate = new Date(priorMs).toISOString().slice(0, 10);
      insertRun.run(
        `prior-run-${i}`,
        "morning-row",
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
        `mr-${i}`,
        "morning-row",
        `prior-run-${i}`,
        priorDate,
        "late-gaming-friend:brian",
        "gaming",
        priorMs,
      );
    }

    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-too-few",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    // No body_data anomaly seeded either → falls through to stakes.
    const events = getSessionEvents(db, SESSION_ID);
    const payload = JSON.parse(events[0].event_json) as { well: string };
    expect(payload.well).toBe("stakes");
  });
});
