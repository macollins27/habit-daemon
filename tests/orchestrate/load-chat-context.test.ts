// Phase 4 / Task 4.2: tests for loadChatContext.
//
// The loader is a pure denormalizer over a real (in-memory + temp-file)
// SQLite database that has had the full migration ladder applied + the
// three Phase-A habits seeded. We populate the source tables directly
// via SQL and assert the returned ChatContext shape.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import { loadChatContext } from "../../src/orchestrate/load-chat-context.js";

const CH_MORNING_ROW = "1000000000000000001";
const CH_STRENGTH = "1000000000000000002";
const CH_WIND_DOWN = "1000000000000000003";
const NOW_MS = Date.parse("2026-05-13T10:00:00.000Z");
const TODAY = "2026-05-13";

interface Harness {
  readonly tempDir: string;
  readonly sessionStore: SessionStore;
  readonly db: Database.Database;
}

async function buildHarness(): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-load-chat-ctx-"));
  const dbPath = join(tempDir, "test.db");
  const migrator = openDatabase(dbPath);
  await runMigrations(migrator, loadMigrations());
  seedHabits(migrator, {
    morningRow: CH_MORNING_ROW,
    strength: CH_STRENGTH,
    windDown: CH_WIND_DOWN,
  });
  migrator.close();
  const sessionStore = new SessionStore({ dbPath });
  return { tempDir, sessionStore, db: sessionStore.db };
}

function teardownHarness(h: Harness): void {
  h.sessionStore.close();
  rmSync(h.tempDir, { recursive: true, force: true });
}

function insertRun(
  db: Database.Database,
  opts: {
    id: string;
    habit_id: string;
    fire_date: string;
    status: string;
    current_level?: number;
    completed_at?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level,
       next_escalation_at, status, completed_at, proof_payload_json,
       skip_reason, proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, 0)`,
  ).run(
    opts.id,
    opts.habit_id,
    opts.fire_date,
    NOW_MS,
    opts.current_level ?? 1,
    opts.status,
    opts.completed_at ?? null,
  );
}

describe("loadChatContext", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(() => {
    teardownHarness(h);
  });

  it("returns empty arrays + null sensors on a fresh DB (only seeded habits)", () => {
    const ctx = loadChatContext({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      now: NOW_MS,
    });

    expect(ctx.nowIso).toBe(new Date(NOW_MS).toISOString());
    expect(ctx.channelName).toBe("morning-row");
    // Three seeded habits.
    expect(ctx.habits.length).toBe(3);
    expect(ctx.todayRuns).toEqual([]);
    expect(ctx.recentRuns30d).toEqual([]);
    expect(ctx.recentEvents).toEqual([]);
    expect(ctx.recentMissReasons).toEqual([]);
    expect(ctx.sensorRecency.concept2_last_iso).toBeNull();
    expect(ctx.sensorRecency.garmin_last_iso).toBeNull();
    expect(ctx.recentChat).toEqual([]);
  });

  it("surfaces today's runs and excludes other dates", () => {
    insertRun(h.db, {
      id: "run-today",
      habit_id: "morning-row",
      fire_date: TODAY,
      status: "pending",
      current_level: 2,
    });
    insertRun(h.db, {
      id: "run-yesterday",
      habit_id: "morning-row",
      fire_date: "2026-05-12",
      status: "completed",
      completed_at: NOW_MS - 100,
    });

    const ctx = loadChatContext({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      now: NOW_MS,
    });

    expect(ctx.todayRuns.length).toBe(1);
    expect(ctx.todayRuns[0]!.habit_id).toBe("morning-row");
    expect(ctx.todayRuns[0]!.status).toBe("pending");
    expect(ctx.todayRuns[0]!.current_level).toBe(2);
  });

  it("recentRuns30d includes runs within 30 days and excludes older runs", () => {
    insertRun(h.db, {
      id: "run-today",
      habit_id: "morning-row",
      fire_date: TODAY,
      status: "pending",
    });
    insertRun(h.db, {
      id: "run-7d",
      habit_id: "strength-mwf",
      fire_date: "2026-05-06",
      status: "completed",
    });
    // 60 days back — outside the 30-day window.
    insertRun(h.db, {
      id: "run-60d",
      habit_id: "wind-down",
      fire_date: "2026-03-13",
      status: "completed",
    });

    const ctx = loadChatContext({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      now: NOW_MS,
    });

    const fireDates = ctx.recentRuns30d.map((r) => r.fire_date);
    expect(fireDates).toContain(TODAY);
    expect(fireDates).toContain("2026-05-06");
    expect(fireDates).not.toContain("2026-03-13");
    // Newest first.
    expect(fireDates[0]).toBe(TODAY);
  });

  it("sensorRecency picks up the most-recent fetched_at per source", () => {
    h.db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, 'concept2', ?, '{}', ?)`,
    ).run("sig-c2-old", "2026-05-12", NOW_MS - 1000);
    h.db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, 'concept2', ?, '{}', ?)`,
    ).run("sig-c2-new", "2026-05-13", NOW_MS - 50);
    h.db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, 'garmin', ?, '{}', ?)`,
    ).run("sig-g-only", "2026-05-13", NOW_MS - 200);

    const ctx = loadChatContext({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      now: NOW_MS,
    });

    expect(ctx.sensorRecency.concept2_last_iso).toBe(
      new Date(NOW_MS - 50).toISOString(),
    );
    expect(ctx.sensorRecency.garmin_last_iso).toBe(
      new Date(NOW_MS - 200).toISOString(),
    );
  });

  it("recentChat filters by channelId AND the 1-hour window", () => {
    // In-channel, recent — included.
    h.sessionStore.append(
      "chat",
      "user_message_received",
      { channelId: CH_MORNING_ROW, text: "hi" },
      { trustLevel: "L1" },
    );
    // Same channel, an assistant reply.
    h.sessionStore.append(
      "chat",
      "assistant_message_sent",
      { channelId: CH_MORNING_ROW, text: "hello" },
      { trustLevel: "L1" },
    );
    // Different channel — excluded.
    h.sessionStore.append(
      "chat",
      "user_message_received",
      { channelId: CH_STRENGTH, text: "from elsewhere" },
      { trustLevel: "L1" },
    );

    // Now stamp an old event by hand (written_iso outside the 1h window).
    const oldIso = new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString();
    h.db.prepare(
      `INSERT INTO session_events (
         session_id, seq, event_json, prev_hash, hash, trust_level, event_type, written_iso
       ) VALUES (?, ?, ?, NULL, ?, 'L1', 'user_message_received', ?)`,
    ).run(
      "chat",
      999,
      JSON.stringify({ channelId: CH_MORNING_ROW, text: "ancient" }),
      "old-hash",
      oldIso,
    );

    const ctx = loadChatContext({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      now: NOW_MS,
    });

    expect(ctx.recentChat.length).toBe(2);
    // Oldest-first order: the user msg precedes the assistant reply.
    expect(ctx.recentChat[0]!.role).toBe("user");
    expect(ctx.recentChat[0]!.text).toBe("hi");
    expect(ctx.recentChat[1]!.role).toBe("assistant");
    expect(ctx.recentChat[1]!.text).toBe("hello");
    // Cross-channel and old events excluded.
    expect(ctx.recentChat.map((m) => m.text)).not.toContain("from elsewhere");
    expect(ctx.recentChat.map((m) => m.text)).not.toContain("ancient");
  });

  it("recentMissReasons respects the 30-day cutoff", () => {
    // miss_reasons.run_id has a FK to habit_runs(id) — seed two real runs.
    insertRun(h.db, {
      id: "run-x",
      habit_id: "morning-row",
      fire_date: "2026-05-10",
      status: "missed",
    });
    insertRun(h.db, {
      id: "run-y",
      habit_id: "morning-row",
      fire_date: "2026-03-01",
      status: "missed",
    });
    h.db.prepare(
      `INSERT INTO miss_reasons (
         id, habit_id, run_id, miss_date, user_response_text, classification,
         inferred_specifics, key_entities_json, classification_confidence,
         gap_metadata_json, created_at
       ) VALUES (?, 'morning-row', 'run-x', ?, 'tired', 'gaming', NULL, NULL, NULL, NULL, ?)`,
    ).run("mr-recent", "2026-05-10", NOW_MS);
    h.db.prepare(
      `INSERT INTO miss_reasons (
         id, habit_id, run_id, miss_date, user_response_text, classification,
         inferred_specifics, key_entities_json, classification_confidence,
         gap_metadata_json, created_at
       ) VALUES (?, 'morning-row', 'run-y', ?, 'old', 'work-late', NULL, NULL, NULL, NULL, ?)`,
    ).run("mr-old", "2026-03-01", NOW_MS - 60 * 24 * 60 * 60 * 1000);

    const ctx = loadChatContext({
      sessionStore: h.sessionStore,
      channelId: CH_MORNING_ROW,
      channelName: "morning-row",
      now: NOW_MS,
    });

    const dates = ctx.recentMissReasons.map((m) => m.miss_date);
    expect(dates).toContain("2026-05-10");
    expect(dates).not.toContain("2026-03-01");
  });
});
