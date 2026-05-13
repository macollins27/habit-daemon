import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { Ledger } from "../../src/daemon/ledger.js";
import { createHabit } from "../../src/orchestrate/create-habit.js";
import {
  archiveHabit,
  unarchiveHabit,
} from "../../src/orchestrate/archive-habit.js";
import type { HabitCreate } from "../../src/api/schemas.js";

let tempDir: string;
let dbPath: string;

function validInput(overrides: Partial<HabitCreate> = {}): HabitCreate {
  return {
    slug: "evening-walk",
    display_name: "Evening walk",
    cadence: "0 19 * * *",
    proof_type: "training_log_photo",
    proof_config: { min_log_entries: 1 },
    why_stakes: { primary: "joints" },
    channel_id: "test-channel-walk",
    ...overrides,
  };
}

/**
 * Register a create-habit-run schedule for the habit so we can verify the
 * archive/unarchive logic toggles its `enabled` column. Mirrors the production
 * pattern in `src/daemon/bootstrap.ts::registerHabitMorningCrons`.
 */
function registerHabitSchedule(
  ledger: Ledger,
  habitId: string,
  cron = "0 19 * * *",
): number {
  const argsJson = JSON.stringify({ habitId });
  const result = ledger.sessionStore.db
    .prepare(
      `INSERT INTO schedules (cron_expr, verb, args_json, missed_run_policy, enabled, dispatch_priority)
       VALUES (?, 'create-habit-run', ?, 'skip', 1, 100)`,
    )
    .run(cron, argsJson);
  return Number(result.lastInsertRowid);
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-archive-habit-"));
  dbPath = join(tempDir, "test.db");
  const db = openDatabase(dbPath);
  await runMigrations(db, loadMigrations());
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("archiveHabit", () => {
  it("sets archived_at to a current ISO timestamp", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      const before = Date.now();
      archiveHabit({ sessionStore: ledger.sessionStore, id });
      const after = Date.now();

      const row = ledger.sessionStore.db
        .prepare("SELECT archived_at FROM habits WHERE id = ?")
        .get(id) as { readonly archived_at: string | null };
      expect(row.archived_at).not.toBeNull();
      const ts = Date.parse(row.archived_at!);
      expect(Number.isFinite(ts)).toBe(true);
      // Must be a valid ISO that falls inside the wall-clock window we
      // captured around the call.
      expect(ts).toBeGreaterThanOrEqual(before - 1);
      expect(ts).toBeLessThanOrEqual(after + 1);
    } finally {
      ledger.close();
    }
  });

  it("disables matching create-habit-run schedule rows for this habit", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      const otherId = createHabit({
        sessionStore: ledger.sessionStore,
        input: validInput({ slug: "other-habit" }),
      }).id;
      const scheduleId = registerHabitSchedule(ledger, id);
      const otherScheduleId = registerHabitSchedule(ledger, otherId);

      archiveHabit({ sessionStore: ledger.sessionStore, id });

      const target = ledger.sessionStore.db
        .prepare("SELECT enabled FROM schedules WHERE id = ?")
        .get(scheduleId) as { readonly enabled: number };
      expect(target.enabled).toBe(0);

      // Other habit's schedule must NOT be disabled.
      const untouched = ledger.sessionStore.db
        .prepare("SELECT enabled FROM schedules WHERE id = ?")
        .get(otherScheduleId) as { readonly enabled: number };
      expect(untouched.enabled).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("appends a habit_archived event", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      archiveHabit({ sessionStore: ledger.sessionStore, id });

      const events = ledger.sessionStore.db
        .prepare(
          `SELECT event_json FROM session_events WHERE event_type = 'habit_archived'`,
        )
        .all() as readonly { readonly event_json: string }[];
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.event_json) as { readonly id: string };
      expect(payload.id).toBe(id);
    } finally {
      ledger.close();
    }
  });

  it("is idempotent on an already-archived row — no second event, no error", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      archiveHabit({ sessionStore: ledger.sessionStore, id });
      // Second call: must not throw, must not append a second event.
      expect(() =>
        archiveHabit({ sessionStore: ledger.sessionStore, id }),
      ).not.toThrow();

      const count = ledger.sessionStore.db
        .prepare(
          `SELECT COUNT(*) AS n FROM session_events WHERE event_type = 'habit_archived'`,
        )
        .get() as { readonly n: number };
      expect(count.n).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("preserves habit_runs rows for this habit", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      ledger.sessionStore.db
        .prepare(
          `INSERT INTO habit_runs (id, habit_id, fire_date, fired_at, current_level, next_escalation_at, status)
           VALUES (?, ?, ?, ?, 1, ?, 'pending')`,
        )
        .run("run-1", id, "2026-05-12", Date.now(), Date.now());

      archiveHabit({ sessionStore: ledger.sessionStore, id });

      const count = ledger.sessionStore.db
        .prepare("SELECT COUNT(*) AS n FROM habit_runs WHERE habit_id = ?")
        .get(id) as { readonly n: number };
      expect(count.n).toBe(1);
    } finally {
      ledger.close();
    }
  });
});

describe("unarchiveHabit", () => {
  it("sets archived_at back to null", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      archiveHabit({ sessionStore: ledger.sessionStore, id });
      unarchiveHabit({ sessionStore: ledger.sessionStore, id });

      const row = ledger.sessionStore.db
        .prepare("SELECT archived_at FROM habits WHERE id = ?")
        .get(id) as { readonly archived_at: string | null };
      expect(row.archived_at).toBeNull();
    } finally {
      ledger.close();
    }
  });

  it("re-enables the matching schedule rows", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      const scheduleId = registerHabitSchedule(ledger, id);
      archiveHabit({ sessionStore: ledger.sessionStore, id });

      const disabled = ledger.sessionStore.db
        .prepare("SELECT enabled FROM schedules WHERE id = ?")
        .get(scheduleId) as { readonly enabled: number };
      expect(disabled.enabled).toBe(0);

      unarchiveHabit({ sessionStore: ledger.sessionStore, id });

      const reenabled = ledger.sessionStore.db
        .prepare("SELECT enabled FROM schedules WHERE id = ?")
        .get(scheduleId) as { readonly enabled: number };
      expect(reenabled.enabled).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("appends a habit_unarchived event", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      archiveHabit({ sessionStore: ledger.sessionStore, id });
      unarchiveHabit({ sessionStore: ledger.sessionStore, id });

      const events = ledger.sessionStore.db
        .prepare(
          `SELECT event_json FROM session_events WHERE event_type = 'habit_unarchived'`,
        )
        .all() as readonly { readonly event_json: string }[];
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.event_json) as { readonly id: string };
      expect(payload.id).toBe(id);
    } finally {
      ledger.close();
    }
  });

  it("is idempotent on a non-archived row — no event, no error", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      // Habit is not archived. unarchive should no-op.
      expect(() =>
        unarchiveHabit({ sessionStore: ledger.sessionStore, id }),
      ).not.toThrow();

      const count = ledger.sessionStore.db
        .prepare(
          `SELECT COUNT(*) AS n FROM session_events WHERE event_type = 'habit_unarchived'`,
        )
        .get() as { readonly n: number };
      expect(count.n).toBe(0);
    } finally {
      ledger.close();
    }
  });
});
