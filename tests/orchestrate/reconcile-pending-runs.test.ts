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

const noopConcept2Sync = async (_date: string): Promise<void> => {
  // intentionally empty — skeleton stage
};

const noopGarminSync = async (_date: string): Promise<void> => {
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

  // ---------------------------------------------------------------------
  // Followups Task 2.1: TZ local-vs-UTC test.
  //
  // The existing happy-path test runs at 15:00 UTC where local-date equals
  // UTC-date in every common TZ, so the local-date code path isn't actually
  // exercised. This test sets TZ to America/New_York and uses now = 02:00
  // UTC = 22:00 local previous day, so local-date and UTC-date diverge. The
  // reconciler must pick up the local-dated run, not the UTC-dated one.
  // ---------------------------------------------------------------------
  it("uses local date (not UTC) when filtering pending runs", async () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const db = sessionStore.db;
      const runId = "test-run-tz";
      // 02:00 UTC on 2026-05-14 → 22:00 local 2026-05-13 in Eastern.
      const nowMs = Date.parse("2026-05-14T02:00:00Z");

      // Seed for local-date 2026-05-13. UTC-date for nowMs is 2026-05-14,
      // so a reconciler using UTC would filter for '2026-05-14' and miss.
      db.prepare(
        `INSERT INTO habit_runs (
           id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
           status, completed_at, proof_payload_json, skip_reason,
           proof_rejection_callout_due
         ) VALUES (?, 'morning-row', ?, ?, 1, NULL, 'pending', NULL, NULL, NULL, 0)`,
      ).run(runId, "2026-05-13", nowMs - 60 * 60 * 1000);

      db.prepare(
        `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
         VALUES (?, 'concept2', '2026-05-13', ?, ?)`,
      ).run(
        "concept2-tz",
        JSON.stringify({
          results: [{
            id: 9876,
            date: "2026-05-13 09:00:00",
            type: "rower",
            duration_seconds: 700,
            distance_meters: 2500,
          }],
        }),
        nowMs,
      );

      const posts: Array<{ channelId: string }> = [];
      const result = await reconcilePendingRuns({
        sessionStore,
        now: nowMs,
        concept2Sync: async () => {},
        garminSync: async () => {},
        postCompletion: async (o) => void posts.push({ channelId: o.channelId }),
      });

      expect(result.attempted).toBe(1);
      expect(result.completed).toBe(1);
      const row = db
        .prepare("SELECT status FROM habit_runs WHERE id = ?")
        .get(runId) as { status: string };
      expect(row.status).toBe("completed");
    } finally {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
  });

  // ---------------------------------------------------------------------
  // Task 1.4: Idempotency.
  //
  // Idempotency comes for free from the SQL filter — `loadPendingRuns`
  // restricts to `status IN ('pending','partial')`, so once a run is
  // flipped to 'completed' the second call won't pick it up. This test
  // pins that invariant so future refactors of `loadPendingRuns` don't
  // silently regress it (e.g. expanding the IN clause to include
  // 'completed' would cause double posting to #wins).
  // ---------------------------------------------------------------------
  it("is idempotent: running twice with the same data completes once on the first call, zero on the second", async () => {
    const db = sessionStore.db;
    const runId = "test-run-idempotent";
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
    const postCompletion = async (o: {
      channelId: string;
      runId: string;
      summary: string;
    }): Promise<void> => {
      posts.push({ channelId: o.channelId, summary: o.summary });
    };

    // First call: closes the pending run.
    const first = await reconcilePendingRuns({
      sessionStore,
      now: nowMs,
      concept2Sync: async () => {},
      garminSync: async () => {},
      postCompletion,
    });

    expect(first.attempted).toBe(1);
    expect(first.completed).toBe(1);
    expect(first.stillPending).toBe(0);
    expect(posts).toHaveLength(2);

    // Second call with identical inputs: the WHERE clause in
    // loadPendingRuns excludes status='completed', so the run is
    // invisible and there is nothing to attempt.
    const second = await reconcilePendingRuns({
      sessionStore,
      now: nowMs,
      concept2Sync: async () => {},
      garminSync: async () => {},
      postCompletion,
    });

    expect(second.attempted).toBe(0);
    expect(second.completed).toBe(0);
    expect(second.stillPending).toBe(0);

    // Row remains completed — not regressed, not re-stamped.
    const updated = db
      .prepare("SELECT status, completed_at FROM habit_runs WHERE id = ?")
      .get(runId) as { status: string; completed_at: number | null };
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).toBe(nowMs);

    // No additional posts on the second call — total stays at 2.
    expect(posts).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // Task 1.3: Garmin wind-down branch.
  //
  // The wind-down branch handles BOTH `status='pending'` AND
  // `status='partial'` rows because the daemon may have already
  // satisfied stage A (typed "shutting down" → status='partial') by the
  // time the Garmin signal arrives. The branch reads the cached
  // sensor_signals row, extracts HH:MM from sleep.sleep_onset_time, and
  // compares against the habit's stage_b_threshold (seeded "23:00").
  // String comparison works for fixed-width zero-padded HH:MM.
  //
  // The reconciler does NOT touch proof_stages — stage A satisfaction
  // is inferred logically from the Garmin row being present. Stage-B
  // miss transitions remain evaluateStageB's responsibility.
  // ---------------------------------------------------------------------
  it("completes a pending wind-down run when Garmin onset is at or before threshold", async () => {
    const db = sessionStore.db;
    const runId = "test-run-windown-1";
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
      "wind-down",
      fireDate,
      Date.parse("2026-05-13T22:00:00Z"),
      1,
      null,
      "pending",
      null,
      null,
      null,
      0,
    );

    // Onset 22:30 < threshold 23:00 → completion.
    db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "garmin-2026-05-13",
      "garmin",
      fireDate,
      JSON.stringify({
        sleep: { sleep_onset_time: "2026-05-13T22:30:00" },
      }),
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
    expect(result.stillPending).toBe(0);

    const updated = db
      .prepare("SELECT status, completed_at FROM habit_runs WHERE id = ?")
      .get(runId) as { status: string; completed_at: number | null };
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).toBe(nowMs);

    expect(posts).toHaveLength(2);
    const channelIds = posts.map((p) => p.channelId).sort();
    expect(channelIds).toEqual([SEED_CHANNELS.windDown, "wins"].sort());
    // The summary must include the onset HH:MM so the operator can
    // sanity-check the autonomous completion from a #wins glance.
    for (const p of posts) {
      expect(p.summary).toContain("22:30");
    }
  });

  it("leaves a partial wind-down run partial when Garmin onset is after threshold", async () => {
    const db = sessionStore.db;
    const runId = "test-run-windown-late";
    const fireDate = "2026-05-13";
    const nowMs = Date.parse("2026-05-13T15:00:00Z");

    // Seed in status='partial' — daemon already saw "shutting down".
    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      "wind-down",
      fireDate,
      Date.parse("2026-05-13T22:00:00Z"),
      1,
      null,
      "partial",
      null,
      null,
      null,
      0,
    );

    // Onset 23:30 > threshold 23:00 → no completion (miss is
    // evaluateStageB's job, not the reconciler's).
    db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "garmin-2026-05-13",
      "garmin",
      fireDate,
      JSON.stringify({
        sleep: { sleep_onset_time: "2026-05-13T23:30:00" },
      }),
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
    expect(result.completed).toBe(0);
    expect(result.stillPending).toBe(1);

    const updated = db
      .prepare("SELECT status, completed_at FROM habit_runs WHERE id = ?")
      .get(runId) as { status: string; completed_at: number | null };
    expect(updated.status).toBe("partial");
    expect(updated.completed_at).toBeNull();

    expect(posts).toHaveLength(0);
  });

  it("leaves a pending wind-down run pending when Garmin onset is post-midnight", async () => {
    // Regression pin: naive lex compare "01:25" < "23:00" returns true, but
    // bedtime at 1:25 AM is past a 23:00 threshold. onsetBeyondThreshold
    // must treat onsets before 12:00 as post-midnight.
    const db = sessionStore.db;
    const runId = "test-run-windown-post-midnight";
    const fireDate = "2026-05-13";
    const nowMs = Date.parse("2026-05-13T15:00:00Z");

    db.prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
         status, completed_at, proof_payload_json, skip_reason,
         proof_rejection_callout_due
       ) VALUES (?, 'wind-down', ?, ?, 1, NULL, 'pending', NULL, NULL, NULL, 0)`,
    ).run(runId, fireDate, Date.parse("2026-05-13T22:00:00Z"));

    db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, 'garmin', ?, ?, ?)`,
    ).run("garmin-2026-05-13", fireDate, JSON.stringify({
      sleep: { sleep_onset_time: "2026-05-13T01:25:00" },
    }), nowMs);

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
    expect(result.completed).toBe(0);
    expect(result.stillPending).toBe(1);

    const updated = db
      .prepare("SELECT status, completed_at FROM habit_runs WHERE id = ?")
      .get(runId) as { status: string; completed_at: number | null };
    expect(updated.status).toBe("pending");
    expect(updated.completed_at).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("completes a partial wind-down run when Garmin onset is at or before threshold", async () => {
    // This is the headline scenario for Task 1.3: the daemon already
    // observed the "shutting down" typed message (status='partial') and
    // is awaiting Garmin onset. When the cached Garmin row arrives with
    // onset ≤ threshold, the reconciler autonomously closes the run.
    //
    // This test pins the SQL `IN ('pending','partial')` semantics — if
    // 'partial' were removed from the loadPendingRuns query, this test
    // would fail because the row would never be loaded.
    const db = sessionStore.db;
    const runId = "test-run-windown-partial-complete";
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
      "wind-down",
      fireDate,
      Date.parse("2026-05-13T22:00:00Z"),
      1,
      null,
      "partial",
      null,
      null,
      null,
      0,
    );

    // Onset 22:30 ≤ threshold 23:00 → completion.
    db.prepare(
      `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "garmin-2026-05-13",
      "garmin",
      fireDate,
      JSON.stringify({
        sleep: { sleep_onset_time: "2026-05-13T22:30:00" },
      }),
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
    expect(result.stillPending).toBe(0);

    const updated = db
      .prepare("SELECT status, completed_at FROM habit_runs WHERE id = ?")
      .get(runId) as { status: string; completed_at: number | null };
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).toBe(nowMs);

    expect(posts).toHaveLength(2);
    const channelIds = posts.map((p) => p.channelId).sort();
    expect(channelIds).toEqual([SEED_CHANNELS.windDown, "wins"].sort());
    for (const p of posts) {
      expect(p.summary).toContain("22:30");
    }
  });

  it("leaves a pending wind-down run untouched when no Garmin row exists", async () => {
    const db = sessionStore.db;
    const runId = "test-run-windown-nodata";
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
      "wind-down",
      fireDate,
      Date.parse("2026-05-13T22:00:00Z"),
      1,
      null,
      "pending",
      null,
      null,
      null,
      0,
    );

    // NOTE: no sensor_signals row for garmin / 2026-05-13.

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
    expect(result.completed).toBe(0);
    expect(result.stillPending).toBe(1);

    const updated = db
      .prepare("SELECT status, completed_at FROM habit_runs WHERE id = ?")
      .get(runId) as { status: string; completed_at: number | null };
    expect(updated.status).toBe("pending");
    expect(updated.completed_at).toBeNull();

    expect(posts).toHaveLength(0);
  });
});
