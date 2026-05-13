// Task 2.2: tests for runHabitCheckin()'s short-circuit on proof-in-cache.
//
// When `checkProvable` finds a qualifying sensor row already on file for the
// (habit, fire_date), `runHabitCheckin` must:
//   - skip dispatch + Discord post entirely;
//   - flip `habit_runs.status` to 'completed' with completed_at = now;
//   - append a `habit_completed` session event with proofPayload metadata
//     (source, session, autoDetected: true);
//   - return { dispatched: false, messagePosted: false, newLevel: currentLevel,
//     nextEscalationAt: null, calloutFired: false }.
//
// The short-circuit lives AFTER section 2 (context composition) and BEFORE
// section 2a (defensive defer guard). Layering pin: a proof-in-cache must
// beat the defensive defer — closing the run takes precedence over giving
// stage-B another 60 seconds. Test 3 covers that ordering specifically.
//
// References:
//   - docs/plans/2026-05-12-habit-daemon-remediation-plan.md § 2.2
//   - src/orchestrate/check-provable.ts
//   - src/orchestrate/habit-checkin.ts

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

const SESSION_ID = "session-test-shortcircuit-0001";

// Mid-day UTC so "yesterday = now - 24h" lands on the prior local date for
// any plausible TZ the test host might run in (same pattern the
// defensive-guard test uses).
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

interface QualifyingSession {
  readonly id: number;
  readonly date: string;
  readonly type: string;
  readonly duration_seconds: number;
  readonly distance_meters: number;
}

/**
 * Insert a Concept2 sensor_signals row for `fireDate` whose first result
 * meets the seeded `morning-row` min_minutes floor (10 minutes).
 */
function seedQualifyingConcept2(
  db: Database.Database,
  fireDate: string,
): QualifyingSession {
  const session: QualifyingSession = {
    id: 7777,
    date: `${fireDate} 09:35:00`,
    type: "rower",
    duration_seconds: 720, // 12 min — comfortably above the 10-min floor
    distance_meters: 2500,
  };
  db.prepare(
    `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    `concept2-${fireDate}`,
    "concept2",
    fireDate,
    JSON.stringify({ results: [session] }),
    NOW_MS,
  );
  return session;
}

/**
 * Insert a Concept2 sensor_signals row whose only session is below the
 * 10-minute floor — should NOT short-circuit.
 */
function seedShortConcept2(db: Database.Database, fireDate: string): void {
  const session = {
    id: 7778,
    date: `${fireDate} 09:35:00`,
    type: "rower",
    duration_seconds: 240, // 4 min — under the floor
    distance_meters: 800,
  };
  db.prepare(
    `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    `concept2-${fireDate}`,
    "concept2",
    fireDate,
    JSON.stringify({ results: [session] }),
    NOW_MS,
  );
}

interface HabitRunRow {
  readonly id: string;
  readonly status: string;
  readonly current_level: number;
  readonly next_escalation_at: number | null;
  readonly completed_at: number | null;
}

function getRun(db: Database.Database, runId: string): HabitRunRow | undefined {
  return db
    .prepare(
      `SELECT id, status, current_level, next_escalation_at, completed_at
         FROM habit_runs
        WHERE id = ?`,
    )
    .get(runId) as HabitRunRow | undefined;
}

interface SessionEventRow {
  readonly id: number;
  readonly session_id: string;
  readonly seq: number;
  readonly event_json: string;
  readonly event_type: string | null;
  readonly trust_level: string;
}

function getSessionEvents(
  db: Database.Database,
  sessionId: string,
): readonly SessionEventRow[] {
  return db
    .prepare(
      `SELECT id, session_id, seq, event_json, event_type, trust_level
         FROM session_events
        WHERE session_id = ?
        ORDER BY seq ASC`,
    )
    .all(sessionId) as readonly SessionEventRow[];
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
  const mockSend = vi.fn().mockResolvedValue({ id: "msg-shortcircuit" });
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

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("runHabitCheckin() short-circuit on proof-in-cache", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkin-shortcircuit-"));
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

  it("short-circuits to completed when Concept2 cache has a qualifying session", async () => {
    seedHabitRun(db, {
      runId: "run-mr-shortcircuit",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
      currentLevel: 2,
    });
    const session = seedQualifyingConcept2(db, TODAY_DATE);

    const { adapter, mockSend, mockFetch } = buildAdapter();
    const dispatchImpl = vi
      .fn()
      .mockRejectedValue(new Error("dispatch must not run"));
    const postImpl = vi
      .fn()
      .mockRejectedValue(new Error("post must not run"));

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-shortcircuit",
      currentLevel: 2,
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    expect(result).toEqual({
      dispatched: false,
      messagePosted: false,
      newLevel: 2,
      nextEscalationAt: null,
      calloutFired: false,
    });

    expect(dispatchImpl).not.toHaveBeenCalled();
    // The injected `postImpl` is for the L1-L5 message path. The short-circuit
    // posts the dual-channel ack via `postToChannel` directly (matching the
    // reconciler), so `postImpl` must remain untouched.
    expect(postImpl).not.toHaveBeenCalled();

    const row = getRun(db, "run-mr-shortcircuit");
    expect(row?.status).toBe("completed");
    expect(row?.completed_at).toBe(NOW_MS);
    // Audit trail mirrors the reconciler's writeCompletion: nullable
    // next_escalation_at + proof_payload_json envelope.
    expect(row?.next_escalation_at).toBeNull();
    const fullRow = db
      .prepare(
        `SELECT proof_payload_json FROM habit_runs WHERE id = ?`,
      )
      .get("run-mr-shortcircuit") as { proof_payload_json: string | null };
    expect(fullRow.proof_payload_json).toBe(
      JSON.stringify({
        proof: {
          source: "concept2",
          session,
          autoDetected: true,
        },
      }),
    );

    // Dual-channel post mirrors the reconciler: source channel
    // (morning-row snowflake) + #wins, each with the
    // `formatMorningRowSummary` content.
    const expectedSummary = `✓ Morning row · ${session.date} · 12:00 · ${session.distance_meters}m`;
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenNthCalledWith(1, {
      content: expectedSummary,
      files: [],
    });
    expect(mockSend).toHaveBeenNthCalledWith(2, {
      content: expectedSummary,
      files: [],
    });
    // First fetch resolves the source-channel snowflake (raw habit.channel_id);
    // second resolves the "wins" ChannelName via the adapter's channelIds map.
    expect(mockFetch).toHaveBeenNthCalledWith(1, CHANNEL_IDS["morning-row"]);
    expect(mockFetch).toHaveBeenNthCalledWith(2, CHANNEL_IDS.wins);

    const events = getSessionEvents(db, SESSION_ID);
    const completedEvents = events.filter(
      (e) => e.event_type === "habit_completed",
    );
    expect(completedEvents.length).toBe(1);
    const payload = JSON.parse(completedEvents[0]!.event_json) as {
      habitId: string;
      runId: string;
      completedAt: number;
      proofPayload: {
        source: string;
        session: Record<string, unknown>;
        autoDetected: boolean;
      };
    };
    expect(payload.habitId).toBe("morning-row");
    expect(payload.runId).toBe("run-mr-shortcircuit");
    expect(payload.completedAt).toBe(NOW_MS);
    expect(payload.proofPayload.source).toBe("concept2");
    expect(payload.proofPayload.autoDetected).toBe(true);
    expect(payload.proofPayload.session).toEqual(session);
  });

  it("falls through to normal dispatch when no cached session matches", async () => {
    seedHabitRun(db, {
      runId: "run-mr-no-cache",
      habitId: "morning-row",
      fireDate: TODAY_DATE,
      currentLevel: 1,
    });
    // Seed a sub-min_minutes session so checkProvable returns provable=false.
    seedShortConcept2(db, TODAY_DATE);

    const { adapter } = buildAdapter();
    const dispatchImpl = vi.fn().mockResolvedValue({
      structured_output: {
        message_text: "Row time. PM5 photo when done.",
        next_check_in_iso: "2026-05-12T13:30:00.000Z",
      },
    });
    const postImpl = vi.fn().mockResolvedValue({ messageId: "msg-fall-through" });

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-no-cache",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    expect(result.dispatched).toBe(true);
    expect(result.messagePosted).toBe(true);
    expect(dispatchImpl).toHaveBeenCalledTimes(1);

    const row = getRun(db, "run-mr-no-cache");
    expect(row?.status).toBe("pending");

    const events = getSessionEvents(db, SESSION_ID);
    const completedEvents = events.filter(
      (e) => e.event_type === "habit_completed",
    );
    expect(completedEvents.length).toBe(0);
  });

  it("short-circuits even when stage-B partial would otherwise defer", async () => {
    // Layering pin: proof-in-cache MUST beat the defensive defer guard.
    // Seed (a) yesterday's wind-down still 'partial' (the trigger for the
    // defer guard at morning-row L1) AND (b) a qualifying Concept2 session
    // for today. The short-circuit lives before the defer guard, so the
    // run closes — no 60-second deferral, no dispatch.
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
      currentLevel: 1,
    });
    seedQualifyingConcept2(db, TODAY_DATE);

    const { adapter, mockSend } = buildAdapter();
    const dispatchImpl = vi
      .fn()
      .mockRejectedValue(new Error("dispatch must not run"));
    const postImpl = vi
      .fn()
      .mockRejectedValue(new Error("post must not run"));

    const result = await runHabitCheckin({
      sessionStore,
      adapter,
      sessionId: SESSION_ID,
      runId: "run-mr-today",
      currentLevel: 1,
      now: NOW_MS,
      dispatchImpl,
      postImpl,
    });

    expect(result.dispatched).toBe(false);
    expect(result.newLevel).toBe(1);
    // Critical: NOT a 60s deferral timestamp — the short-circuit ran first.
    expect(result.nextEscalationAt).toBeNull();

    expect(dispatchImpl).not.toHaveBeenCalled();
    // The L1-L5 postImpl is NOT used by the short-circuit; the dual-channel
    // ack goes through `postToChannel` directly. Verify that explicitly.
    expect(postImpl).not.toHaveBeenCalled();
    // Two dual-channel posts (source + #wins) still happen on short-circuit.
    expect(mockSend).toHaveBeenCalledTimes(2);

    const row = getRun(db, "run-mr-today");
    expect(row?.status).toBe("completed");
    expect(row?.completed_at).toBe(NOW_MS);
  });
});
