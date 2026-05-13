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

describe("reconcilePendingRuns()", () => {
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

  it("marks a pending morning-row run completed when Concept2 has a qualifying session", async () => {
    // -----------------------------------------------------------------
    // Setup: pending morning-row run on the local date matching `now`
    // (2026-05-13), AND a cached sensor_signals row keyed the same way.
    //
    // The cached payload must use the post-boundary-transform shape
    // (`duration_seconds` / `distance_meters` / ISO date) since commit
    // e6a69c7 made sync write transformed shapes — the reconciler reads
    // the cached row directly, so it sees transformed data.
    // -----------------------------------------------------------------
    const db = sessionStore.db;
    const runId = "test-run-1";
    const fireDate = "2026-05-13";
    const nowMs = Date.parse("2026-05-13T15:00:00Z");

    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "morning-row",
      fireDate,
      Date.parse("2026-05-13T09:05:00Z"),
      1,
      null,
      "pending",
      null,
      null,
      null,
      0,
    );

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
      fireDate,
      JSON.stringify({ results: [qualifyingSession] }),
      nowMs,
    );

    const posts: Array<{ channelId: string; summary: string }> = [];

    const result = await reconcilePendingRuns({
      sessionStore,
      now: nowMs,
      concept2Sync: async () => {},
      garminSync: async () => {},
      postCompletion: async (o) =>
        void posts.push({ channelId: o.channelId, summary: o.summary }),
    });

    expect(result.attempted).toBe(1);
    expect(result.completed).toBe(1);

    const updated = db
      .prepare("SELECT status, completed_at FROM habit_runs WHERE id = ?")
      .get(runId) as { status: string; completed_at: number | null };
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).toBe(nowMs);

    expect(posts).toHaveLength(2);
    const channelIds = posts.map((p) => p.channelId).sort();
    expect(channelIds).toEqual(
      [SEED_CHANNELS.morningRow, "wins"].sort(),
    );
  });
});
