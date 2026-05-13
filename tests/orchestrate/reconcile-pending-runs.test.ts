// Task 1.1: reconcilePendingRuns skeleton.
//
// The reconciler closes pending habit_runs when external sensor data
// (Concept2, Garmin) arrives after the user has stopped responding to the
// daemon's prompts. Phase 1 layers logic onto this skeleton:
//   - 1.2: Concept2 sync + run completion
//   - 1.3: Garmin sync + run completion
//   - 1.4: idempotency
//   - 1.5: cron wiring (`*/2 * * * *`)
//
// This test pins the empty-DB contract: when no pending runs exist,
// the reconciler reports zero attempted, zero completed, zero still pending.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import { reconcilePendingRuns } from "../../src/orchestrate/reconcile-pending-runs.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const NOW_MS = 1_715_600_000_000;

// -----------------------------------------------------------------------------
// Stubs: no-op async sensor + posting functions.
// -----------------------------------------------------------------------------

const noopConcept2Sync = async (_opts: {
  habitId: string;
  runId: string;
  date: Date;
}): Promise<void> => {
  // intentionally empty — skeleton stage
};

const noopGarminSync = async (_opts: {
  habitId: string;
  runId: string;
  date: Date;
}): Promise<void> => {
  // intentionally empty — skeleton stage
};

const noopPostCompletion = async (_opts: {
  channelId: string;
  runId: string;
  summary: string;
}): Promise<void> => {
  // intentionally empty — skeleton stage
};

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("reconcilePendingRuns() — skeleton", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-reconcile-"));
    dbPath = join(tempDir, "store.db");

    const migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, SEED_CHANNELS);
    migrator.close();

    sessionStore = new SessionStore({ dbPath });
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns zero counts when no pending runs exist", async () => {
    const result = await reconcilePendingRuns({
      sessionStore,
      now: NOW_MS,
      concept2Sync: noopConcept2Sync,
      garminSync: noopGarminSync,
      postCompletion: noopPostCompletion,
    });

    expect(result).toEqual({
      attempted: 0,
      completed: 0,
      stillPending: 0,
    });
  });
});
