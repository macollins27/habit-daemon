import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { Ledger } from "../../src/daemon/ledger.js";
import { createHabit } from "../../src/orchestrate/create-habit.js";
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

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-create-habit-"));
  dbPath = join(tempDir, "test.db");
  const db = openDatabase(dbPath);
  await runMigrations(db, loadMigrations());
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createHabit", () => {
  it("inserts a habit row with archived_at null, a created_at, and an id matching /^habit_/", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const result = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      expect(result.id).toMatch(/^habit_/);

      const row = ledger.sessionStore.db
        .prepare("SELECT id, name, archived_at, created_at, active FROM habits WHERE id = ?")
        .get(result.id) as {
          readonly id: string;
          readonly name: string;
          readonly archived_at: string | null;
          readonly created_at: number;
          readonly active: number;
        };
      expect(row.id).toBe(result.id);
      expect(row.name).toBe("Evening walk");
      expect(row.archived_at).toBeNull();
      expect(typeof row.created_at).toBe("number");
      expect(row.created_at).toBeGreaterThan(0);
      expect(row.active).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("rejects invalid cron via parseCronExpression throw", () => {
    const ledger = new Ledger({ dbPath });
    try {
      expect(() =>
        createHabit({
          sessionStore: ledger.sessionStore,
          input: validInput({ cadence: "not-a-cron" }),
        }),
      ).toThrowError(/cron/i);
      const count = ledger.sessionStore.db
        .prepare("SELECT COUNT(*) AS n FROM habits WHERE id = 'habit_evening-walk'")
        .get() as { readonly n: number };
      expect(count.n).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("appends exactly one habit_created event to session_events with the input payload", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const result = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      const events = ledger.sessionStore.db
        .prepare(
          `SELECT event_type, event_json FROM session_events WHERE event_type = 'habit_created'`,
        )
        .all() as readonly { readonly event_type: string; readonly event_json: string }[];
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.event_json) as {
        readonly id: string;
        readonly input: HabitCreate;
      };
      expect(payload.id).toBe(result.id);
      expect(payload.input.slug).toBe("evening-walk");
      expect(payload.input.display_name).toBe("Evening walk");
    } finally {
      ledger.close();
    }
  });

  it("rejects duplicate slug with an error containing 'slug'", () => {
    const ledger = new Ledger({ dbPath });
    try {
      createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      expect(() =>
        createHabit({ sessionStore: ledger.sessionStore, input: validInput() }),
      ).toThrowError(/slug/);
      const count = ledger.sessionStore.db
        .prepare("SELECT COUNT(*) AS n FROM habits WHERE id = 'habit_evening-walk'")
        .get() as { readonly n: number };
      expect(count.n).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("Zod schema rejects malformed input (missing display_name) before any DB write", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const bad = { ...validInput() } as Record<string, unknown>;
      delete bad["display_name"];
      expect(() =>
        createHabit({
          sessionStore: ledger.sessionStore,
          // Cast through unknown — this is the unsafe-input boundary test.
          input: bad as unknown as HabitCreate,
        }),
      ).toThrow();
      const count = ledger.sessionStore.db
        .prepare("SELECT COUNT(*) AS n FROM habits")
        .get() as { readonly n: number };
      expect(count.n).toBe(0);
    } finally {
      ledger.close();
    }
  });
});
