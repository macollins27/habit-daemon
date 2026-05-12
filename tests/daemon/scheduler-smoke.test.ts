import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { schedulerTick } from "../../src/daemon/scheduler.js";

describe("scheduler tick", () => {
  it("runs against empty schedules table without error", async () => {
    const db = new Database(":memory:");
    // schedules table shape matches the daemon's ledger (from src/daemon/ledger.ts
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
    // habit_runs table is also queried by schedulerTick (Task 32 added
    // next_escalation_at polling). The smoke test only verifies the tick
    // doesn't throw against empty tables — the shape here mirrors
    // migration 001 (the FK to habits is omitted since habits isn't
    // created here; SQLite doesn't enforce FKs without PRAGMA anyway).
    db.exec(`CREATE TABLE habit_runs (
      id                          TEXT PRIMARY KEY,
      habit_id                    TEXT NOT NULL,
      fire_date                   TEXT NOT NULL,
      fired_at                    INTEGER NOT NULL,
      current_level               INTEGER NOT NULL DEFAULT 1,
      next_escalation_at          INTEGER,
      status                      TEXT NOT NULL,
      completed_at                INTEGER,
      proof_payload_json          TEXT,
      skip_reason                 TEXT,
      proof_rejection_callout_due INTEGER NOT NULL DEFAULT 0
    );`);
    await expect(schedulerTick({ db, dispatch: async () => {} })).resolves.not.toThrow();
  });
});
