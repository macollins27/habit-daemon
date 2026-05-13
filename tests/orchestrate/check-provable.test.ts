// Task 2.1: checkProvable helper.
//
// Pure read-only check that answers "is there already cached sensor data
// proving this habit was done on this fire_date?". Used by Task 2.2 to
// short-circuit habit-checkin escalation when the user has already rowed
// (or wound down) and the daemon's escalation chain would otherwise nag.
//
// This test pins three contracts:
//   1. A qualifying Concept2 session yields { provable: true, source: 'concept2', payload }.
//   2. Absence of any sensor_signals row for the date yields not-provable.
//   3. A below-min_minutes session yields not-provable — the same min_minutes
//      filter that `findQualifyingSession` enforces inside the reconciler.
//
// The Garmin/wind-down branch is intentionally deferred (plan §2.1) — this
// task is the minimal read-only proof-cache check used by L3.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import type Database from "better-sqlite3";
import { checkProvable } from "../../src/orchestrate/check-provable.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const FIRE_DATE = "2026-05-13";

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("checkProvable()", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-checkprovable-"));
    dbPath = join(tempDir, "store.db");

    db = openDatabase(dbPath);
    await runMigrations(db, loadMigrations());
    seedHabits(db, SEED_CHANNELS);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns provable when Concept2 has a qualifying session", () => {
    // 10:03 rower session ≥ 10-minute floor → qualifying.
    const qualifyingSession = {
      id: 999,
      date: "2026-05-13 09:35:00",
      type: "rower",
      duration_seconds: 603.3,
      distance_meters: 2279,
    };
    db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "concept2-2026-05-13",
      "concept2",
      FIRE_DATE,
      JSON.stringify({ results: [qualifyingSession] }),
      Date.parse("2026-05-13T15:00:00Z"),
    );

    const result = checkProvable({
      db,
      habitId: "morning-row",
      fireDate: FIRE_DATE,
    });

    expect(result.provable).toBe(true);
    expect(result.source).toBe("concept2");
    expect(result.payload).toEqual(qualifyingSession);
  });

  it("returns not-provable when no Concept2 row exists for the date", () => {
    // No sensor_signals row at all — fresh DB after migrations + seedHabits.
    const result = checkProvable({
      db,
      habitId: "morning-row",
      fireDate: FIRE_DATE,
    });

    expect(result.provable).toBe(false);
    expect(result.source).toBeUndefined();
    expect(result.payload).toBeUndefined();
  });

  it("returns not-provable when the cached session is below min_minutes", () => {
    // 4-minute rower session — under the seeded 10-minute floor.
    const shortSession = {
      id: 998,
      date: "2026-05-13 09:35:00",
      type: "rower",
      duration_seconds: 240, // 4 minutes
      distance_meters: 800,
    };
    db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "concept2-2026-05-13",
      "concept2",
      FIRE_DATE,
      JSON.stringify({ results: [shortSession] }),
      Date.parse("2026-05-13T15:00:00Z"),
    );

    const result = checkProvable({
      db,
      habitId: "morning-row",
      fireDate: FIRE_DATE,
    });

    expect(result.provable).toBe(false);
    expect(result.source).toBeUndefined();
    expect(result.payload).toBeUndefined();
  });
});
