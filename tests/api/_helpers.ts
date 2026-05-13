/**
 * Test helpers for the api/* test suite.
 *
 * `setupHabitDb()` creates a throwaway SQLite file in a temp dir, runs every
 * migration, and returns a Ledger pointing at it plus a `cleanup` function
 * that closes the ledger and removes the temp dir. Tests own the lifetime
 * of the returned ledger and must call `cleanup()` (or wrap it in
 * `afterEach`).
 *
 * `seedHabit()` inserts a habit row directly via `createHabit` so that the
 * test's habit has gone through the same orchestration path as production.
 * The two helpers together keep every api test below ~50 LOC.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { Ledger } from "../../src/daemon/ledger.js";
import { createHabit } from "../../src/orchestrate/create-habit.js";
import type { HabitCreate } from "../../src/api/schemas.js";

export interface HabitDbHandle {
  readonly ledger: Ledger;
  readonly dbPath: string;
  readonly cleanup: () => void;
}

export async function setupHabitDb(): Promise<HabitDbHandle> {
  const tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-api-test-"));
  const dbPath = join(tempDir, "test.db");
  const db = openDatabase(dbPath);
  await runMigrations(db, loadMigrations());
  db.close();
  const ledger = new Ledger({ dbPath });
  return {
    ledger,
    dbPath,
    cleanup: () => {
      ledger.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export function defaultHabitInput(overrides: Partial<HabitCreate> = {}): HabitCreate {
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

export function seedHabit(
  handle: HabitDbHandle,
  overrides: Partial<HabitCreate> = {},
): string {
  const result = createHabit({
    sessionStore: handle.ledger.sessionStore,
    input: defaultHabitInput(overrides),
  });
  return result.id;
}
