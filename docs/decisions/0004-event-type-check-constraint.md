# ADR 0004: Audit-log events are tagged with a typed event_type column + SQL CHECK enforcement

**Status:** Accepted
**Date:** 2026-05-12

## Context

`session_events` is the hash-chained, append-only audit log for the
daemon. Every meaningful agent action — habit prompts sent, user
responses, proof attempts, proposals emitted and applied, sensor
failures — is appended as a row whose payload lives in a JSON blob
column (`event_json`).

A blob-only schema has two problems:

1. **Queryability.** Any "show me all `proposal_emitted` events for
   this session" query has to parse JSON in SQL or pull every row
   into the application and filter in TypeScript. Both are slow and
   neither is what an append-only audit log is for.
2. **Typo blast radius.** Without a typed event-type column, any
   caller can pass an arbitrary string as the event type. A typo
   (`"propsal_emitted"`) silently corrupts the audit chain's
   interpretability — the hash chain is still valid, but the
   semantic meaning is lost. There is no compile-time or run-time
   guard.

## Decision

`session_events` carries an `event_type TEXT` column (currently
nullable for migration tolerance) constrained by a SQL `CHECK` that
enumerates exactly the allowed event-type literals.

The TypeScript side defines `SessionEventType` as a string-literal
union of the same set of values, and `SessionStore.append()` requires
a `SessionEventType` parameter. `SessionStore.load()` projects
`event_type` back into the returned event rows so callers can branch
on type without parsing the JSON payload.

The current allowed set is sixteen values, grouped:

- **Habit-flow events (8):** `habit_prompt_sent`, `habit_user_response`,
  `habit_proof_received`, `habit_completed`, `habit_missed`,
  `habit_skip_requested`, `habit_dodge_requested`,
  `proof_attempt_rejected`.
- **Proposal events (7):** `proposal_emitted`, `proposal_applied`,
  `proposal_rejected`, `proposal_discussion_opened`,
  `proposal_discussion_message`, `proposal_resolved`,
  `plan_change_applied`.
- **Infrastructure events (1):** `sensor_failure_logged`.

## Consequences

- TypeScript callers get compile-time rejection of typos and unknown
  event types via the string-literal union.
- The SQL `CHECK` catches any path that bypasses the TypeScript type
  system (raw SQL, future language bindings, manual database edits).
- Audit-log queries can filter on `event_type` directly without
  parsing `event_json`, and indices on `(session_id, event_type)` or
  `(event_type, created_at)` are now meaningful.
- The audit-chain contract is now explicit and self-documenting in
  the schema. The CHECK clause itself enumerates the contract.
- **Cost:** adding a new event type requires a SQLite table-rebuild
  migration (create new table with widened CHECK, `INSERT … SELECT`,
  drop old, rename, recreate triggers and indexes). SQLite has no
  `ALTER TABLE … DROP CONSTRAINT` or `ALTER TABLE … ADD CHECK`. Each
  new event type pays this cost once, in exchange for the
  enforcement guarantee.

## Alternatives considered

- **Leave event-type semantics implicit in `event_json`.** Cheapest
  to write, most expensive to live with. Fails the queryability goal
  and provides no guard against typos.
- **Reference table with foreign key from `session_events.event_type`.**
  A separate `event_types` table plus a FK. Adds a table to maintain
  and a join to every read. For a closed, application-defined enum
  whose membership changes only via code change, a `CHECK` is
  strictly simpler.
- **Application-level enum without SQL `CHECK`.** Relies on the
  TypeScript boundary being the only path into the table. Any future
  caller (a one-off script, a migration, a debugging session in the
  SQLite CLI) that writes a bad value goes unnoticed until the audit
  log is queried. Defense in depth requires both layers.
