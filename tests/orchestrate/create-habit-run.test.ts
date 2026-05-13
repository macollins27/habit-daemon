import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { createHabitRun } from "../../src/orchestrate/create-habit-run.js";

const NOW_MS = Date.UTC(2026, 4, 12, 13, 5, 0);
const TODAY = "2026-05-12";
const CHANNEL_IDS = {
  morningRow: "test-channel-row",
  strength: "test-channel-strength",
  windDown: "test-channel-wind-down",
};

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-create-run-"));
  dbPath = join(tempDir, "test.db");
  const db = openDatabase(dbPath);
  await runMigrations(db, loadMigrations());
  seedHabits(db, CHANNEL_IDS);
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createHabitRun", () => {
  it("inserts a habit_runs row with current_level=1, status='pending', next_escalation_at=now", () => {
    const db = openDatabase(dbPath);
    const result = createHabitRun({ db, habitId: "morning-row", now: NOW_MS, today: TODAY });
    expect(result.created).toBe(true);
    expect(typeof result.runId).toBe("string");

    const row = db
      .prepare("SELECT * FROM habit_runs WHERE id = ?")
      .get(result.runId) as {
        habit_id: string;
        fire_date: string;
        current_level: number;
        status: string;
        next_escalation_at: number;
        fired_at: number;
      };
    expect(row.habit_id).toBe("morning-row");
    expect(row.fire_date).toBe(TODAY);
    expect(row.current_level).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.next_escalation_at).toBe(NOW_MS);
    expect(row.fired_at).toBe(NOW_MS);
    db.close();
  });

  it("is idempotent: second call for same (habit_id, today) returns existing row, does not create new", () => {
    const db = openDatabase(dbPath);
    const first = createHabitRun({ db, habitId: "morning-row", now: NOW_MS, today: TODAY });
    const second = createHabitRun({ db, habitId: "morning-row", now: NOW_MS + 60_000, today: TODAY });
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM habit_runs WHERE habit_id='morning-row' AND fire_date=?")
      .get(TODAY) as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it("throws on unknown habitId without writing a row", () => {
    const db = openDatabase(dbPath);
    expect(() =>
      createHabitRun({ db, habitId: "nonexistent", now: NOW_MS, today: TODAY }),
    ).toThrowError(/nonexistent/);
    const count = db.prepare("SELECT COUNT(*) AS n FROM habit_runs").get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });

  it("creates separate rows for different habits on the same day", () => {
    const db = openDatabase(dbPath);
    const row = createHabitRun({ db, habitId: "morning-row", now: NOW_MS, today: TODAY });
    const strength = createHabitRun({ db, habitId: "strength-mwf", now: NOW_MS, today: TODAY });
    expect(row.created).toBe(true);
    expect(strength.created).toBe(true);
    expect(row.runId).not.toBe(strength.runId);
    db.close();
  });
});
