import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { schedulerTick } from "../../src/daemon/scheduler.js";

describe("scheduler tick", () => {
  it("runs against empty schedules table without error", async () => {
    const db = new Database(":memory:");
    // schedules table shape == PLW's (from src/daemon/ledger.ts
    // applyLedgerSchema) + dispatch_priority column added by migration 003.
    // Reconciled with production reality 2026-05-12: see commit history.
    db.exec(`CREATE TABLE schedules (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      cron_expr         TEXT NOT NULL,
      verb              TEXT NOT NULL,
      args_json         TEXT NOT NULL,
      missed_run_policy TEXT NOT NULL DEFAULT 'skip',
      enabled           INTEGER NOT NULL DEFAULT 1,
      last_run_iso      TEXT,
      next_run_iso      TEXT,
      dispatch_priority INTEGER NOT NULL DEFAULT 100
    );`);
    await expect(schedulerTick({ db, dispatch: async () => {} })).resolves.not.toThrow();
  });
});
