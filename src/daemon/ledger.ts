// scripts/lib/orchestrator/ledger.ts
//
// orchestrator state on top of SessionStore.
// Tables: runs, dispatches, actions, cursors, findings, schedules.
//
// References:

import { SessionStore } from "./session-store.js";

export type RunStatus = "running" | "succeeded" | "failed" | "aborted" | "killed";
export type FindingsStatus = "CLEAN" | "FINDINGS" | "FAILED" | "UNKNOWN";
export type Confidence = "low" | "medium" | "high";
export type Severity = "BLOCKER" | "MAJOR" | "MINOR" | "INFO";
export type MissedRunPolicy = "skip" | "catchup" | "fail";

export interface Run {
  readonly run_id: string;
  readonly verb: string;
  readonly args_json: string;
  readonly started_iso: string;
  readonly ended_iso: string | null;
  readonly status: RunStatus;
  readonly git_head_sha: string;
  readonly git_dirty: 0 | 1;
  readonly cost_cap_usd: number | null;
  readonly cost_actual_usd: number;
  readonly killed_by: string | null;
}

export interface Dispatch {
  readonly id: number;
  readonly run_id: string;
  readonly session_id: string | null;
  readonly skill: string;
  readonly args: string;
  readonly scope: string;
  readonly authorized_paths_json: string;
  readonly model: string;
  readonly dispatched_iso: string;
  readonly completed_iso: string | null;
  readonly artifact_path: string | null;
  readonly tool_uses: number | null;
  readonly wall_clock_ms: number | null;
  readonly cost_usd: number | null;
  readonly write_set_json: string | null;
  readonly git_commit_sha_after: string | null;
  readonly git_dirty_files_json: string | null;
  readonly findings_status: FindingsStatus | null;
  readonly root_cause: string | null;
  readonly evidence: string | null;
  readonly confidence: Confidence | null;
  readonly verified: 0 | 1;
  readonly verification_error: string | null;
  readonly hash_chain_record_id: number | null;
}

export interface Finding {
  readonly id: number;
  readonly run_id: string;
  readonly dispatch_id: number | null;
  readonly source: string;
  readonly severity: Severity;
  readonly scope: string;
  readonly body: string;
  readonly artifact_ref: string | null;
  readonly git_sha_ref: string | null;
  readonly created_iso: string;
  readonly resolved: 0 | 1;
  readonly resolved_iso: string | null;
}

export interface OpenFindingsCount {
  readonly blockers: number;
  readonly major: number;
  readonly minor: number;
  readonly info: number;
}

export interface LedgerOptions {
  readonly dbPath: string;
}

export class Ledger {
  readonly sessionStore: SessionStore;
  // db is the underlying Database handle from sessionStore. We intentionally
  // share so the daemon's tables and Anthropic's session_events live in the same file
  // with the same WAL + foreign-key enforcement.
  private get db() {
    return this.sessionStore.db;
  }

  constructor(opts: LedgerOptions) {
    this.sessionStore = new SessionStore({ dbPath: opts.dbPath });
    this.applyLedgerSchema();
  }

  private applyLedgerSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id              TEXT PRIMARY KEY,
        verb                TEXT NOT NULL,
        args_json           TEXT NOT NULL,
        started_iso         TEXT NOT NULL,
        ended_iso           TEXT,
        status              TEXT NOT NULL
                            CHECK(status IN ('running','succeeded','failed','aborted','killed')),
        git_head_sha        TEXT NOT NULL,
        git_dirty           INTEGER NOT NULL CHECK(git_dirty IN (0,1)),
        cost_cap_usd        REAL,
        cost_actual_usd     REAL NOT NULL DEFAULT 0,
        killed_by           TEXT
      );

      CREATE TABLE IF NOT EXISTS dispatches (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id                  TEXT NOT NULL REFERENCES runs(run_id),
        session_id              TEXT REFERENCES sessions(session_id),
        skill                   TEXT NOT NULL,
        args                    TEXT NOT NULL,
        scope                   TEXT NOT NULL,
        authorized_paths_json   TEXT NOT NULL,
        model                   TEXT NOT NULL,
        dispatched_iso          TEXT NOT NULL,
        completed_iso           TEXT,
        artifact_path           TEXT,
        tool_uses               INTEGER,
        wall_clock_ms           INTEGER,
        cost_usd                REAL,
        write_set_json          TEXT,
        git_commit_sha_after    TEXT,
        git_dirty_files_json    TEXT,
        findings_status         TEXT
                                CHECK(findings_status IN ('CLEAN','FINDINGS','FAILED','UNKNOWN')),
        root_cause              TEXT,
        evidence                TEXT,
        confidence              TEXT
                                CHECK(confidence IN ('low','medium','high')),
        verified                INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
        verification_error      TEXT,
        hash_chain_record_id    INTEGER REFERENCES session_events(id)
      );

      CREATE INDEX IF NOT EXISTS idx_dispatches_run ON dispatches(run_id);

      CREATE TABLE IF NOT EXISTS actions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          TEXT NOT NULL REFERENCES runs(run_id),
        dispatch_id     INTEGER REFERENCES dispatches(id),
        kind            TEXT NOT NULL,
        payload_json    TEXT NOT NULL,
        reverted        INTEGER NOT NULL DEFAULT 0 CHECK(reverted IN (0,1)),
        reverted_iso    TEXT,
        created_iso     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id);

      CREATE TABLE IF NOT EXISTS cursors (
        kind          TEXT PRIMARY KEY,
        last_pos      TEXT NOT NULL,
        updated_iso   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS findings (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id        TEXT NOT NULL REFERENCES runs(run_id),
        dispatch_id   INTEGER REFERENCES dispatches(id),
        source        TEXT NOT NULL,
        severity      TEXT NOT NULL CHECK(severity IN ('BLOCKER','MAJOR','MINOR','INFO')),
        scope         TEXT NOT NULL,
        body          TEXT NOT NULL,
        artifact_ref  TEXT,
        git_sha_ref   TEXT,
        created_iso   TEXT NOT NULL,
        resolved      INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
        resolved_iso  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_findings_open
        ON findings(resolved, severity)
        WHERE resolved = 0;

      CREATE TABLE IF NOT EXISTS schedules (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        cron_expr           TEXT NOT NULL,
        verb                TEXT NOT NULL,
        args_json           TEXT NOT NULL,
        missed_run_policy   TEXT NOT NULL DEFAULT 'skip'
                            CHECK(missed_run_policy IN ('skip','catchup','fail')),
        enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        last_run_iso        TEXT,
        next_run_iso        TEXT
      );
    `);
  }

  startRun(args: {
    runId: string;
    verb: string;
    argsJson: string;
    gitHeadSha: string;
    gitDirty: boolean;
    costCapUsd?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, verb, args_json, started_iso, status, git_head_sha, git_dirty, cost_cap_usd)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        args.runId,
        args.verb,
        args.argsJson,
        new Date().toISOString(),
        args.gitHeadSha,
        args.gitDirty ? 1 : 0,
        args.costCapUsd ?? null,
      );
  }

  endRun(runId: string, status: RunStatus, killedBy?: string): void {
    this.db
      .prepare(`UPDATE runs SET ended_iso = ?, status = ?, killed_by = ? WHERE run_id = ?`)
      .run(new Date().toISOString(), status, killedBy ?? null, runId);
  }

  /**
   * Add to the run's accumulated cost. Called by remediate.ts after each
   * dispatch with the dispatch's envelope total_cost_usd. Surfaced in
   * the status command so the founder sees per-run cost (not just per-day).
   */
  addRunCost(runId: string, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.db
      .prepare(`UPDATE runs SET cost_actual_usd = cost_actual_usd + ? WHERE run_id = ?`)
      .run(amount, runId);
  }

  listRecentRuns(limit = 10): readonly Run[] {
    return this.db
      .prepare(`SELECT * FROM runs ORDER BY started_iso DESC LIMIT ?`)
      .all(limit) as Run[];
  }

  countOpenFindings(): OpenFindingsCount {
    const rows = this.db
      .prepare(
        `SELECT severity, COUNT(*) AS n
         FROM findings WHERE resolved = 0
         GROUP BY severity`,
      )
      .all() as readonly { severity: string; n: number }[];
    const out: { -readonly [K in keyof OpenFindingsCount]: number } = {
      blockers: 0,
      major: 0,
      minor: 0,
      info: 0,
    };
    for (const r of rows) {
      const s = r.severity.toUpperCase();
      if (s === "BLOCKER") out.blockers += r.n;
      else if (s === "MAJOR") out.major += r.n;
      else if (s === "MINOR") out.minor += r.n;
      else out.info += r.n;
    }
    return out;
  }

  countBlockedDispatches(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM dispatches
         WHERE verification_error LIKE 'gate-block%' AND verified = 0`,
      )
      .get() as { n: number };
    return row.n;
  }

  listBlockedDispatches(limit = 20): readonly Dispatch[] {
    return this.db
      .prepare(
        `SELECT * FROM dispatches
         WHERE verification_error LIKE 'gate-block%' AND verified = 0
         ORDER BY dispatched_iso DESC LIMIT ?`,
      )
      .all(limit) as Dispatch[];
  }

  getRun(runId: string): Run | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as
      | Run
      | undefined;
    return row ?? null;
  }

  getDispatch(id: number): Dispatch | null {
    const row = this.db.prepare(`SELECT * FROM dispatches WHERE id = ?`).get(id) as
      | Dispatch
      | undefined;
    return row ?? null;
  }

  getFinding(id: number): Finding | null {
    const row = this.db.prepare(`SELECT * FROM findings WHERE id = ?`).get(id) as
      | Finding
      | undefined;
    return row ?? null;
  }

  listDispatchesForRun(runId: string): readonly Dispatch[] {
    return this.db
      .prepare(`SELECT * FROM dispatches WHERE run_id = ? ORDER BY dispatched_iso ASC`)
      .all(runId) as Dispatch[];
  }

  /**
   * Insert a new finding row. Used by the qa command to bridge qa-runner's
   * SUMMARY.json into the orchestrator's findings table for the status command
   * surfacing.
   */
  writeFinding(args: {
    runId: string;
    dispatchId: number | null;
    source: string;
    severity: Severity;
    scope: string;
    body: string;
    artifactRef?: string | null;
    gitShaRef?: string | null;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO findings
           (run_id, dispatch_id, source, severity, scope, body, artifact_ref, git_sha_ref, created_iso)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.runId,
        args.dispatchId,
        args.source,
        args.severity,
        args.scope,
        args.body,
        args.artifactRef ?? null,
        args.gitShaRef ?? null,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  writeAction(args: {
    runId: string;
    dispatchId: number | null;
    kind: string;
    payloadJson: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO actions (run_id, dispatch_id, kind, payload_json, created_iso)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(args.runId, args.dispatchId, args.kind, args.payloadJson, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /**
   * Run a callback inside a transaction. better-sqlite3 transactions are
   * synchronous, so the callback must not perform async work.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.sessionStore.close();
  }
}
