// SQLite-backed implementation of Anthropic's SessionStore interface.
// Append-only events table with hash-chain (per aat-chain.ts).
// Sessions table tracks parent/child relationships for SDK forkSession.
//
// References:
//   - https://code.claude.com/docs/en/agent-sdk/sessions

import Database from "better-sqlite3";
import { buildRecord, type AatRecord, type TrustLevel } from "./aat-chain.js";

export type SessionStatus = "active" | "completed" | "failed" | "aborted";

/**
 * Allowed values for `session_events.event_type`. 15 of these come from the
 * design doc § 2 (habit-daemon-design.md, session_events extension list) and
 * `sensor_failure_logged` comes from Phase A plan Task 15. The SQLite CHECK
 * constraint on `session_events.event_type` is "NULL OR IN (these 16 values)";
 * new code MUST pass one of these literals via `SessionStore.append()`. The
 * column remains nullable to allow infrastructure-level events (carried over
 * from the predecessor fork) that predate this typed taxonomy.
 */
export type SessionEventType =
  // Habit-flow events (8): lifecycle of a single habit run.
  | "habit_prompt_sent"
  | "habit_user_response"
  | "habit_proof_received"
  | "habit_completed"
  | "habit_missed"
  | "habit_skip_requested"
  | "habit_dodge_requested"
  | "proof_attempt_rejected"

  // Proposal events (7): self-improvement proposal lifecycle.
  | "proposal_emitted"
  | "proposal_applied"
  | "proposal_rejected"
  | "proposal_discussion_opened"
  | "proposal_discussion_message"
  | "proposal_resolved"
  | "plan_change_applied"

  // Infrastructure events (1): non-habit, non-proposal signal.
  | "sensor_failure_logged";

export interface SessionRow {
  readonly session_id: string;
  readonly created_iso: string;
  readonly parent_session: string | null;
  readonly fork_uuid: string | null;
  readonly status: SessionStatus;
}

export interface SessionEventRow extends AatRecord {
  readonly id: number;
  readonly sessionId: string;
  // Nullable because the SQLite CHECK constraint is "NULL OR IN (16 values)"
  // — rows predating the typed taxonomy (or written via raw SQL without an
  // event_type) carry NULL. New rows written via append() always carry a
  // typed literal.
  readonly eventType: SessionEventType | null;
}

export interface AppendOptions {
  readonly trustLevel: TrustLevel;
}

export interface SessionStoreOptions {
  readonly dbPath: string;
}

export class SessionStore {
  readonly db: Database.Database;

  constructor(opts: SessionStoreOptions) {
    // The caller (bin/dispatch via env.sh, or test setup) MUST ensure the parent
    // directory exists before constructing SessionStore. We do not mkdir here:
    // security/detect-non-literal-fs-filename would flag a non-literal path,
    // and lint suppressions are not allowed in non-allowlisted scripts.
    // If the directory is missing, better-sqlite3 throws a clear SQLITE_CANTOPEN
    // error pointing at the path — fail-fast with actionable message.
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id      TEXT PRIMARY KEY,
        created_iso     TEXT NOT NULL,
        parent_session  TEXT REFERENCES sessions(session_id),
        fork_uuid       TEXT,
        status          TEXT NOT NULL CHECK(status IN ('active','completed','failed','aborted'))
      );

      CREATE TABLE IF NOT EXISTS session_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES sessions(session_id),
        seq           INTEGER NOT NULL,
        event_json    TEXT NOT NULL,
        prev_hash     TEXT,
        hash          TEXT NOT NULL,
        trust_level   TEXT NOT NULL CHECK(trust_level IN ('L0','L1','L2','L3','L4')),
        event_type    TEXT CHECK(event_type IS NULL OR event_type IN (
          'habit_prompt_sent', 'habit_user_response', 'habit_proof_received',
          'habit_completed', 'habit_missed', 'habit_skip_requested',
          'habit_dodge_requested', 'proof_attempt_rejected', 'proposal_emitted',
          'proposal_applied', 'proposal_rejected', 'proposal_discussion_opened',
          'proposal_discussion_message', 'proposal_resolved', 'plan_change_applied',
          'sensor_failure_logged'
        )),
        written_iso   TEXT NOT NULL,
        UNIQUE(session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session
        ON session_events(session_id, seq);

      CREATE TRIGGER IF NOT EXISTS session_events_no_update
        BEFORE UPDATE ON session_events
        BEGIN
          SELECT RAISE(FAIL, 'session_events is append-only (use a new event for corrections)');
        END;

      CREATE TRIGGER IF NOT EXISTS session_events_no_delete
        BEFORE DELETE ON session_events
        BEGIN
          SELECT RAISE(FAIL, 'session_events is append-only (deletion forbidden)');
        END;
    `);
  }

  /**
   * Create a new session row. Idempotent: if session_id already exists, no-op.
   */
  createSession(sessionId: string, parentSession?: string, forkUuid?: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (session_id, created_iso, parent_session, fork_uuid, status)
         VALUES (?, ?, ?, ?, 'active')`,
      )
      .run(sessionId, new Date().toISOString(), parentSession ?? null, forkUuid ?? null);
  }

  setSessionStatus(sessionId: string, status: SessionStatus): void {
    this.db.prepare(`UPDATE sessions SET status = ? WHERE session_id = ?`).run(status, sessionId);
  }

  getSession(sessionId: string): SessionRow | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as
      | SessionRow
      | undefined;
    return row ?? null;
  }

  /**
   * Anthropic SessionStore.append — append an event with hash chain.
   * Computes prev_hash from the latest event in the session (or null for seq=0).
   * Returns the inserted row id.
   *
   * `eventType` is a typed taxonomy label persisted in the
   * `session_events.event_type` column. The SQLite CHECK constraint enforces
   * it is one of `SessionEventType`'s 16 values; passing anything else throws.
   */
  append(
    sessionId: string,
    eventType: SessionEventType,
    event: unknown,
    opts: AppendOptions,
  ): number {
    return this.db.transaction(() => {
      this.createSession(sessionId);
      const last = this.db
        .prepare(
          `SELECT seq, hash FROM session_events
           WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
        )
        .get(sessionId) as { seq: number; hash: string } | undefined;
      const seq = (last?.seq ?? -1) + 1;
      const prevHash = last?.hash ?? null;
      const record = buildRecord({ seq, event, prevHash, trustLevel: opts.trustLevel });
      const result = this.db
        .prepare(
          `INSERT INTO session_events
             (session_id, seq, event_json, prev_hash, hash, trust_level, event_type, written_iso)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          record.seq,
          record.eventJson,
          record.prevHash,
          record.hash,
          record.trustLevel,
          eventType,
          record.writtenIso,
        );
      return Number(result.lastInsertRowid);
    })();
  }

  /**
   * Anthropic SessionStore.load — read all events for a session in seq order.
   */
  load(sessionId: string): SessionEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id AS sessionId, seq, event_json AS eventJson,
                prev_hash AS prevHash, hash, trust_level AS trustLevel,
                event_type AS eventType, written_iso AS writtenIso
         FROM session_events
         WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all(sessionId) as SessionEventRow[];
    return rows;
  }

  /**
   * Anthropic SessionStore.listSessions — return session ids in created order desc.
   */
  listSessions(limit?: number): readonly string[] {
    const stmt =
      limit !== undefined
        ? this.db.prepare(`SELECT session_id FROM sessions ORDER BY created_iso DESC LIMIT ?`)
        : this.db.prepare(`SELECT session_id FROM sessions ORDER BY created_iso DESC`);
    const rows = (limit !== undefined ? stmt.all(limit) : stmt.all()) as readonly {
      session_id: string;
    }[];
    return rows.map((r) => r.session_id);
  }

  /** Periodic WAL checkpoint per R3 + R11 (long-running daemon mitigation). */
  walCheckpoint(): void {
    this.db.pragma("wal_checkpoint(RESTART)");
  }

  close(): void {
    this.db.close();
  }
}
