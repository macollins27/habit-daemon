// Task 28: tests for runHabitCheckin() at L3 with the body_data_well payload.
//
// L3 body_data fires when the user's body data — Garmin sleep / HRV / sleep
// onset — disagrees with their 30-day baseline. The selector (Task 26) chose
// body_data over stakes when (a) no pattern fires and (b) anomalies were
// detected. Task 28 wires the L3 body_data prompt template and the
// orchestration plumbing.
//
// What L3 body_data adds on top of L3 stakes (Task 27):
//   - The verb threads `wellSelection.well === 'body_data'` into a dedicated
//     prompt template (level-3-body-data.ts) parameterised by the list of
//     anomalous signals + the habit's framing template.
//   - It records `well: 'body_data'` + `anomalousSignals` in the
//     habit_prompt_sent event payload so downstream auditing and selector
//     logic can read what fired.
//
// Coverage here is integration-flavoured: we drive runHabitCheckin() end to
// end against a real SQLite session store, seed real Garmin sensor_signals
// rows, and assert that the dispatched prompt mentions the anomalous signal
// and that the persisted event payload carries the expected metadata.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 28
//   - src/lib/anomaly-detector.ts (pure detector)
//   - src/lib/prompt-templates/level-3-body-data.ts (template under test)
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
import { buildL3BodyDataTemplate } from "../../src/lib/prompt-templates/level-3-body-data.js";

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

const SESSION_ID = "session-test-l3-body-0001";
const FIRE_DATE = "2026-05-12";
const NOW_MS = Date.parse("2026-05-12T10:05:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function seedHabitRun(
  db: Database.Database,
  opts: {
    runId: string;
    habitId: string;
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
    FIRE_DATE,
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
 * Insert 30 Garmin baseline rows with high rem_minutes plus one prior-night
 * row whose rem_minutes is in the bottom 20%. The selector (prior_night
 * mode for morning-row) will flag rem_minutes as anomalous.
 */
function seedAnomalousGarminPriorNight(
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

interface BuildAdapterResult {
  readonly adapter: DiscordAdapter;
  readonly mockSend: ReturnType<typeof vi.fn>;
  readonly mockFetch: ReturnType<typeof vi.fn>;
}

function buildAdapter(): BuildAdapterResult {
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-l3-body" });
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
          "REM was bottom 15% of your month — rowing primes parasympathetic recovery. Where are we at?",
        next_check_in_iso: "2026-05-12T10:35:00.000Z",
      },
    };
  };
  return { impl, calls };
}

// ----------------------------------------------------------------------------
// Template smoke tests (pure unit, no DB)
// ----------------------------------------------------------------------------

describe("buildL3BodyDataTemplate()", () => {
  it("returns levelName 'L3'", () => {
    const tpl = buildL3BodyDataTemplate({
      well: "body_data",
      anomalousSignals: ["rem_minutes"],
      framingTemplate: "TEST_FRAMING",
    });
    expect(tpl.levelName).toBe("L3");
  });

  it("interpolates the anomalous signals into the voice rules", () => {
    const tpl = buildL3BodyDataTemplate({
      well: "body_data",
      anomalousSignals: ["rem_minutes", "hrv"],
      framingTemplate: "TEST_FRAMING",
    });
    expect(tpl.voiceRules).toContain("rem_minutes");
    expect(tpl.voiceRules).toContain("hrv");
  });

  it("interpolates the framing template into the voice rules", () => {
    const tpl = buildL3BodyDataTemplate({
      well: "body_data",
      anomalousSignals: ["rem_minutes"],
      framingTemplate: "MY_TEST_FRAMING_TEMPLATE",
    });
    expect(tpl.voiceRules).toContain("MY_TEST_FRAMING_TEMPLATE");
  });

  it("voice rules forbid generic pep-talk / moralizing content", () => {
    const tpl = buildL3BodyDataTemplate({
      well: "body_data",
      anomalousSignals: ["rem_minutes"],
      framingTemplate: "X",
    });
    const rules = tpl.voiceRules.toLowerCase();
    expect(rules).toMatch(/lecture|pep talk|moralize|moralise|motivational/);
  });

  it("output schema parses as JSON with message_text + next_check_in_iso", () => {
    const tpl = buildL3BodyDataTemplate({
      well: "body_data",
      anomalousSignals: ["rem_minutes"],
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

describe("runHabitCheckin() at L3 — body_data_well anomaly", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkin-l3-body-"));
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

  it("dispatches L3 body_data prompt when prior-night rem_minutes is anomalous; event payload carries anomalousSignals", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l3-body",
      habitId: "morning-row",
      currentLevel: 3,
    });
    // Baseline rem = 120, prior-night rem = 10 → bottom-20% anomaly.
    seedAnomalousGarminPriorNight(db, {
      priorDate: "2026-05-11",
      baselineRem: 120,
      priorNightRem: 10,
    });

    const { adapter, mockSend, mockFetch } = buildAdapter();
    const { impl, calls } = happyDispatch();

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-body",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toContain("L3");
    // The body_data voice rules name the anomalous signal — the model sees it.
    expect(calls[0]!.prompt).toContain("rem_minutes");

    expect(mockFetch).toHaveBeenCalledWith(CHANNEL_IDS["morning-row"]);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const row = getRun(db, "run-mr-l3-body");
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
      anomalousSignals: readonly string[];
    };
    expect(payload.well).toBe("body_data");
    expect(payload.anomalousSignals).toEqual(["rem_minutes"]);
    expect(payload.level).toBe(3);

    expect(result.newLevel).toBe(4);
    expect(result.dispatched).toBe(true);
    expect(result.messagePosted).toBe(true);
  });

  it("falls back to stakes (does NOT dispatch body_data) when prior-night value is within baseline", async () => {
    seedHabitRun(db, {
      runId: "run-mr-l3-no-anomaly",
      habitId: "morning-row",
      currentLevel: 3,
    });
    // Prior-night rem = 120, baseline rem = 120 → no anomaly.
    seedAnomalousGarminPriorNight(db, {
      priorDate: "2026-05-11",
      baselineRem: 120,
      priorNightRem: 120,
    });

    const { adapter } = buildAdapter();
    const { impl, calls } = happyDispatch();

    await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-l3-no-anomaly",
      currentLevel: 3,
      now: NOW_MS,
      dispatchImpl: impl,
    });

    expect(calls.length).toBe(1);
    // Without a body-data anomaly, the selector falls through to stakes.
    const events = getSessionEvents(db, SESSION_ID);
    const payload = JSON.parse(events[0].event_json) as { well: string };
    expect(payload.well).toBe("stakes");
  });
});
