// Task 1.5: tests that the `reconcile-pending-runs` cron + dispatch route
// are wired into bootstrap.ts. Two layers:
//
//   1. `registerReconcilePendingRunsCron(db)` inserts the expected row and
//      is idempotent on re-call.
//   2. `makeInProcessDispatch({...})` returns a dispatch function whose
//      `"reconcile-pending-runs"` case runs to completion against an
//      empty habit_runs table without throwing. The empty-DB smoke is
//      sufficient here because the orchestrator's outer loop is empty,
//      meaning the concept2Sync/garminSync wrappers (which would otherwise
//      hit real Concept2/Garmin endpoints) never fire. End-to-end coverage
//      of the per-row branches already lives in
//      tests/orchestrate/reconcile-pending-runs.test.ts.
//
// References:
//   - src/orchestrate/reconcile-pending-runs.ts (cron helper + orchestrator)
//   - src/daemon/bootstrap.ts (makeInProcessDispatch + DispatchDeps)
//   - tests/orchestrate/retry-unresolved-sensors.test.ts (cron-registration
//     test precedent we mirror)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { Ledger } from "../../src/daemon/ledger.js";
import {
  makeInProcessDispatch,
  type DispatchDeps,
} from "../../src/daemon/bootstrap.js";
import { registerReconcilePendingRunsCron } from "../../src/orchestrate/reconcile-pending-runs.js";
import type { DiscordAdapter } from "../../src/lib/discord-adapter.js";

// -----------------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------------

interface ScheduleRow {
  readonly id: number;
  readonly cron_expr: string;
  readonly verb: string;
  readonly args_json: string;
  readonly missed_run_policy: string;
  readonly enabled: number;
  readonly dispatch_priority: number;
}

interface CountRow {
  readonly n: number;
}

function countSchedules(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM schedules WHERE verb = ?")
    .get("reconcile-pending-runs") as CountRow;
  return row.n;
}

// Minimal DiscordAdapter stub — the empty-DB dispatch path never reaches
// postToChannel (no pending runs → no posts), but DispatchDeps requires
// the field, so we provide a structurally-compatible no-op.
function makeAdapterStub(): DiscordAdapter {
  return {
    // The Client object is never invoked in the empty-DB path. We cast to
    // the shape the type expects; if any code path accessed it, the cast
    // would throw at access time and the test would surface a clear
    // failure rather than silent passage.
    client: {} as DiscordAdapter["client"],
    channelIds: {
      "morning-row": "ch-row",
      strength: "ch-strength",
      "wind-down": "ch-wind-down",
      wins: "ch-wins",
      "sunday-review": "ch-sunday-review",
    },
    isReady: () => false,
  };
}

// Minimal Concept2 credentials/tokens. The empty-DB path never invokes
// concept2SyncDate, so these are placeholders that satisfy the type.
const DUMMY_CONCEPT2: DispatchDeps["concept2"] = {
  credentials: {
    client_id: "test-client",
    client_secret: "test-secret",
    redirect_uri: "http://localhost/cb",
  },
  tokens: {
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_at: 0,
    token_type: "Bearer",
    scope: "",
  },
};

// -----------------------------------------------------------------------------
// Tests.
// -----------------------------------------------------------------------------

describe("registerReconcilePendingRunsCron()", () => {
  let tempDir: string;
  let dbPath: string;
  let migrator: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-reconcile-cron-"));
    dbPath = join(tempDir, "store.db");
    migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
  });

  afterEach(() => {
    migrator.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("inserts one schedules row for reconcile-pending-runs on a 2-minute cron", () => {
    registerReconcilePendingRunsCron(migrator);

    const rows = migrator
      .prepare("SELECT * FROM schedules WHERE verb = ?")
      .all("reconcile-pending-runs") as readonly ScheduleRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].cron_expr).toBe("*/2 * * * *");
    expect(rows[0].args_json).toBe("{}");
    expect(rows[0].missed_run_policy).toBe("skip");
    expect(rows[0].enabled).toBe(1);
    expect(rows[0].dispatch_priority).toBe(50);
  });

  it("is idempotent: a second call does not insert a duplicate row", () => {
    registerReconcilePendingRunsCron(migrator);
    registerReconcilePendingRunsCron(migrator);

    expect(countSchedules(migrator)).toBe(1);
  });
});

describe('makeInProcessDispatch — "reconcile-pending-runs" route', () => {
  let tempDir: string;
  let dbPath: string;
  let ledger: Ledger;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-reconcile-dispatch-"));
    dbPath = join(tempDir, "store.db");
    const migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    migrator.close();
    ledger = new Ledger({ dbPath });
  });

  afterEach(() => {
    ledger.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("dispatches the reconcile-pending-runs verb without throwing when no pending runs exist", async () => {
    const dispatch = makeInProcessDispatch({
      ledger,
      adapter: makeAdapterStub(),
      sessionId: "test-session-reconcile-wiring",
      concept2: { ...DUMMY_CONCEPT2 },
    });

    // No habit_runs seeded → reconciler's pending-runs query is empty →
    // the for-loop doesn't iterate → neither sync wrapper nor
    // postCompletion wrapper is invoked. The dispatch case should
    // return cleanly.
    await expect(
      dispatch("reconcile-pending-runs", "{}"),
    ).resolves.toBeUndefined();
  });
});
