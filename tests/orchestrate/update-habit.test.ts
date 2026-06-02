import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { Ledger } from "../../src/daemon/ledger.js";
import { createHabit } from "../../src/orchestrate/create-habit.js";
import { updateHabit } from "../../src/orchestrate/update-habit.js";
import type { HabitCreate, HabitPatch } from "../../src/api/schemas.js";

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
  tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-update-habit-"));
  dbPath = join(tempDir, "test.db");
  const db = openDatabase(dbPath);
  await runMigrations(db, loadMigrations());
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("updateHabit", () => {
  it("patches a single field (display_name) without touching other columns", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      const before = ledger.sessionStore.db
        .prepare("SELECT name, cron_expr, channel_id FROM habits WHERE id = ?")
        .get(id) as {
          readonly name: string;
          readonly cron_expr: string;
          readonly channel_id: string;
        };

      updateHabit({
        sessionStore: ledger.sessionStore,
        id,
        patch: { display_name: "Morning walk" },
      });

      const after = ledger.sessionStore.db
        .prepare("SELECT name, cron_expr, channel_id FROM habits WHERE id = ?")
        .get(id) as {
          readonly name: string;
          readonly cron_expr: string;
          readonly channel_id: string;
        };

      expect(after.name).toBe("Morning walk");
      expect(after.cron_expr).toBe(before.cron_expr);
      expect(after.channel_id).toBe(before.channel_id);
    } finally {
      ledger.close();
    }
  });

  it("re-validates cron when cadence changes; rejects invalid cron", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      expect(() =>
        updateHabit({
          sessionStore: ledger.sessionStore,
          id,
          patch: { cadence: "not-a-cron" },
        }),
      ).toThrowError(/cron/i);

      const row = ledger.sessionStore.db
        .prepare("SELECT cron_expr FROM habits WHERE id = ?")
        .get(id) as { readonly cron_expr: string };
      expect(row.cron_expr).toBe("0 19 * * *");
    } finally {
      ledger.close();
    }
  });

  it("appends habit_updated event with changed_fields array equal to keys of the patch", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      const patch: HabitPatch = { display_name: "Noon walk", channel_id: "ch-2" };
      updateHabit({ sessionStore: ledger.sessionStore, id, patch });

      const events = ledger.sessionStore.db
        .prepare(
          `SELECT event_json FROM session_events WHERE event_type = 'habit_updated'`,
        )
        .all() as readonly { readonly event_json: string }[];
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.event_json) as {
        readonly id: string;
        readonly changed_fields: readonly string[];
        readonly patch: HabitPatch;
      };
      expect(payload.id).toBe(id);
      expect(payload.changed_fields).toEqual(["display_name", "channel_id"]);
      expect(payload.patch.display_name).toBe("Noon walk");
    } finally {
      ledger.close();
    }
  });

  it("rejects unknown habit id with error containing 'unknown'", () => {
    const ledger = new Ledger({ dbPath });
    try {
      expect(() =>
        updateHabit({
          sessionStore: ledger.sessionStore,
          id: "habit_does-not-exist",
          patch: { display_name: "x" },
        }),
      ).toThrowError(/unknown/);
    } finally {
      ledger.close();
    }
  });

  it("rejects empty patch with error containing 'empty'", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      expect(() =>
        updateHabit({ sessionStore: ledger.sessionStore, id, patch: {} }),
      ).toThrowError(/empty/);
    } finally {
      ledger.close();
    }
  });

  it("patches proof_config and why_stakes as JSON (object → JSON.stringify in DB)", () => {
    const ledger = new Ledger({ dbPath });
    try {
      const { id } = createHabit({ sessionStore: ledger.sessionStore, input: validInput() });
      updateHabit({
        sessionStore: ledger.sessionStore,
        id,
        patch: {
          proof_config: { min_log_entries: 5, vision_subject: "training_log" },
          why_stakes: { primary: "spine", secondary: "joints" },
        },
      });

      const row = ledger.sessionStore.db
        .prepare("SELECT proof_config_json, why_stakes_json FROM habits WHERE id = ?")
        .get(id) as {
          readonly proof_config_json: string;
          readonly why_stakes_json: string;
        };
      expect(JSON.parse(row.proof_config_json)).toEqual({
        min_log_entries: 5,
        vision_subject: "training_log",
      });
      expect(JSON.parse(row.why_stakes_json)).toEqual({
        primary: "spine",
        secondary: "joints",
      });
    } finally {
      ledger.close();
    }
  });
});
