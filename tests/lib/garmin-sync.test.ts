// Task 14: Garmin sleep cache → sensor_signals.
//
// syncDate() wraps fetchSleep() and persists one row per (source='garmin',
// payload_date=YYYY-MM-DD). Mirrors Task 11's concept2 syncDate() pattern.
//
// These tests use an injected spawnImpl (the same hook fetchSleep exposes for
// unit-testing the bridge) so no real Python processes are spawned. The
// database is an in-memory SQLite with the full migration set applied, so the
// sensor_signals UNIQUE(source, payload_date) constraint and INSERT OR REPLACE
// semantics are exercised against the real schema.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import {
  syncDate,
  GarminAuthExpired,
  GarminNetworkError,
  type GarminSleep,
  type SpawnResultLike,
} from "../../src/lib/garmin-adapter.js";

interface RecordedSpawn {
  readonly cmd: string;
  readonly args: readonly string[];
}

interface SensorSignalRow {
  readonly id: string;
  readonly source: string;
  readonly payload_date: string;
  readonly payload_json: string;
  readonly fetched_at: number;
}

function makeRecordingSpawn(
  result: SpawnResultLike,
  recorder: { calls: RecordedSpawn[] },
): (cmd: string, args: readonly string[]) => SpawnResultLike {
  return (cmd, args) => {
    recorder.calls.push({ cmd, args: [...args] });
    return result;
  };
}

function readAllSignals(db: Database.Database): SensorSignalRow[] {
  return db
    .prepare(
      "SELECT id, source, payload_date, payload_json, fetched_at FROM sensor_signals ORDER BY id",
    )
    .all() as SensorSignalRow[];
}

const FULL_SLEEP_JSON = JSON.stringify({
  sleep_onset_time: "2026-05-12T01:23:00",
  total_sleep_minutes: 412,
  rem_minutes: 78,
  deep_sleep_minutes: 65,
  hrv: 51.2,
});

const FULL_SLEEP_EXPECTED: GarminSleep = {
  sleep_onset_time: "2026-05-12T01:23:00",
  total_sleep_minutes: 412,
  rem_minutes: 78,
  deep_sleep_minutes: 65,
  hrv: 51.2,
};

describe("syncDate() — happy path", () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:34:56.000Z"));
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("writes exactly one sensor_signals row with the expected shape", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: FULL_SLEEP_JSON, stderr: "" },
      recorder,
    );

    await syncDate({
      db,
      date: "2026-05-12",
      spawnImpl,
    });

    const rows = readAllSignals(db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe("garmin-2026-05-12");
    expect(row.source).toBe("garmin");
    expect(row.payload_date).toBe("2026-05-12");
    expect(row.fetched_at).toBe(Date.now());

    const parsed = JSON.parse(row.payload_json) as {
      sleep: GarminSleep | null;
    };
    expect(parsed).toEqual({ sleep: FULL_SLEEP_EXPECTED });
  });

  it("writes payload_json = {\"sleep\":null} when Garmin returns empty {}", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await syncDate({
      db,
      date: "2026-05-12",
      spawnImpl,
    });

    const rows = readAllSignals(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("garmin-2026-05-12");
    expect(rows[0].source).toBe("garmin");
    expect(rows[0].payload_json).toBe('{"sleep":null}');
  });
});

describe("syncDate() — idempotency", () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("a second sync for the same date replaces the existing row (no duplicates)", async () => {
    // First sync: empty sleep payload.
    const recorder1: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl1 = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder1,
    );

    await syncDate({ db, date: "2026-05-12", spawnImpl: spawnImpl1 });

    const firstRows = readAllSignals(db);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0].payload_json).toBe('{"sleep":null}');
    const firstFetchedAt = firstRows[0].fetched_at;

    // Advance the clock so we can verify fetched_at updates on replace.
    vi.setSystemTime(new Date("2026-05-12T13:00:00.000Z"));

    // Second sync: now returns full data.
    const recorder2: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl2 = makeRecordingSpawn(
      { status: 0, stdout: FULL_SLEEP_JSON, stderr: "" },
      recorder2,
    );

    await syncDate({ db, date: "2026-05-12", spawnImpl: spawnImpl2 });

    const secondRows = readAllSignals(db);
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].id).toBe("garmin-2026-05-12");
    expect(secondRows[0].fetched_at).toBe(Date.now());
    expect(secondRows[0].fetched_at).toBeGreaterThan(firstFetchedAt);

    const parsed = JSON.parse(secondRows[0].payload_json) as {
      sleep: GarminSleep | null;
    };
    expect(parsed).toEqual({ sleep: FULL_SLEEP_EXPECTED });
  });
});

describe("syncDate() — error propagation", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
  });

  it("propagates GarminAuthExpired (exit 2) and writes nothing", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      {
        status: 2,
        stdout: "",
        stderr: "Auth failed (token may be expired)\n",
      },
      recorder,
    );

    let captured: unknown = null;
    try {
      await syncDate({ db, date: "2026-05-12", spawnImpl });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GarminAuthExpired);
    expect(readAllSignals(db)).toHaveLength(0);
  });

  it("propagates GarminNetworkError (exit 3) and writes nothing", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      {
        status: 3,
        stdout: "",
        stderr: "Network or API error: ConnectionResetError\n",
      },
      recorder,
    );

    let captured: unknown = null;
    try {
      await syncDate({ db, date: "2026-05-12", spawnImpl });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GarminNetworkError);
    expect(readAllSignals(db)).toHaveLength(0);
  });
});

describe("syncDate() — fetchSleep arg forwarding", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
  });

  it("forwards date and the default 5-field set to the Python shim", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await syncDate({ db, date: "2026-05-12", spawnImpl });

    expect(recorder.calls).toHaveLength(1);
    const args = recorder.calls[0].args;

    const dateIndex = args.indexOf("--date");
    expect(dateIndex).toBeGreaterThanOrEqual(0);
    expect(args[dateIndex + 1]).toBe("2026-05-12");

    const fieldsIndex = args.indexOf("--fields");
    expect(fieldsIndex).toBeGreaterThanOrEqual(0);
    expect(args[fieldsIndex + 1]).toBe(
      "sleep_onset_time,total_sleep_minutes,rem_minutes,deep_sleep_minutes,hrv",
    );
  });

  it("forwards a custom fields override to fetchSleep", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await syncDate({
      db,
      date: "2026-05-12",
      spawnImpl,
      fields: ["rem_minutes", "hrv"],
    });

    const args = recorder.calls[0].args;
    const fieldsIndex = args.indexOf("--fields");
    expect(args[fieldsIndex + 1]).toBe("rem_minutes,hrv");
  });

  it("forwards stub:true to fetchSleep (--stub flag present)", async () => {
    const recorder: { calls: RecordedSpawn[] } = { calls: [] };
    const spawnImpl = makeRecordingSpawn(
      { status: 0, stdout: "{}", stderr: "" },
      recorder,
    );

    await syncDate({
      db,
      date: "2026-05-12",
      spawnImpl,
      stub: true,
    });

    expect(recorder.calls[0].args).toContain("--stub");
  });
});
