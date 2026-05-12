// Task 33: verify-proof verb — routing scaffold.
//
// The verb is invoked by the Discord message listener when a user posts a
// message (typically with an attachment) in a habit channel during an
// active habit_run. Its sole job is to:
//
//   1. Load the habit row (by id) and read `habit.proof_type`.
//   2. Dispatch to one of three sub-verbs based on the string:
//        - concept2_api+photo_fallback → verifyConcept2OrPhoto
//        - training_log_photo          → verifyTrainingLogPhoto
//        - typed_msg+garmin_sleep      → verifyWindDownStageA
//   3. Return the sub-verb's `VerifyProofResult` unchanged.
//
// The router itself performs NO database writes and NO Discord side
// effects — those are the sub-verbs' responsibility (Tasks 34/35/36 each
// own one sub-verb implementation).
//
// Sub-verbs are dependency-injected via `opts.subVerbs` (the same pattern
// habit-checkin uses for dispatchImpl/postImpl). For Task 33 the wiring
// is intentionally absent: production callers will supply real sub-verbs
// once Tasks 34/35/36 land; until then, the router throws a descriptive
// "<verb> not yet wired (Task 34/35/36)" error so a premature production
// invocation fails loud.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 33
//   - docs/plans/2026-05-12-habit-daemon-design.md § 4 (proof verification)
//   - src/orchestrate/habit-checkin.ts (DI-seam precedent)

import type Database from "better-sqlite3";
import type { Message } from "discord.js";
import type { SessionStore } from "../daemon/session-store.js";

// -----------------------------------------------------------------------------
// Type contracts.
// -----------------------------------------------------------------------------

/**
 * The three proof types recognised by Phase A. Mirrors the literal strings
 * seeded by `seedHabits()` in `src/db/seed-habits.ts`.
 */
export type ProofType =
  | "concept2_api+photo_fallback"
  | "training_log_photo"
  | "typed_msg+garmin_sleep";

/**
 * Result envelope returned by every sub-verb. The router forwards this
 * unchanged to its caller.
 *
 * `outcome` semantics (design § 4):
 *   - completed: proof accepted, habit_runs.status flips to 'completed'.
 *   - partial:   stage-A satisfied for wind-down; sub-verb keeps the run
 *                pending until stage B's Garmin window opens.
 *   - pending:   proof seen but not yet decidable (e.g. vision verdict in
 *                a queue). Caller should not advance the run state.
 *   - rejected:  proof seen and rejected. Sub-verb is expected to set the
 *                proof_rejection_callout_due flag and bump
 *                vision_rejection_count.
 */
export interface VerifyProofResult {
  readonly outcome: "completed" | "partial" | "pending" | "rejected";
  readonly reason?: string;
  /** Structured proof data persisted to habit_runs.proof_payload_json. */
  readonly proofPayload?: unknown;
}

/**
 * Shared context every sub-verb receives. The router builds this by
 * forwarding fields from `VerifyProofOptions`. `db` is intentionally
 * absent here — sub-verbs use `sessionStore.db` so the single-writer
 * invariant (Task 15 pattern) is preserved.
 */
export interface SubVerbContext {
  readonly sessionStore: SessionStore;
  readonly sessionId: string;
  readonly habitId: string;
  readonly runId: string;
  readonly message: Message;
  readonly now: number;
}

/** Sub-verb signature. Tasks 34/35/36 each implement one of these. */
export type SubVerb = (ctx: SubVerbContext) => Promise<VerifyProofResult>;

/**
 * The router's input. `db` is the read handle the router uses to look up
 * the habit row; `sessionStore` is forwarded to the sub-verb (sub-verbs
 * write through `sessionStore.db` to preserve single-writer invariants).
 *
 * `subVerbs` is optional so Task 33's test suite can omit individual
 * verbs to assert the "not yet wired" error path. Production callers
 * (once Tasks 34/35/36 land) will always supply all three.
 */
export interface VerifyProofOptions extends SubVerbContext {
  readonly db: Database.Database;
  readonly subVerbs?: {
    readonly verifyConcept2OrPhoto?: SubVerb;
    readonly verifyTrainingLogPhoto?: SubVerb;
    readonly verifyWindDownStageA?: SubVerb;
  };
}

// -----------------------------------------------------------------------------
// Internal helpers.
// -----------------------------------------------------------------------------

interface HabitProofRow {
  readonly proof_type: string;
}

function loadProofType(
  db: Database.Database,
  habitId: string,
): string {
  const row = db
    .prepare("SELECT proof_type FROM habits WHERE id = ?")
    .get(habitId) as HabitProofRow | undefined;

  if (row === undefined) {
    throw new Error(`habit not found: ${habitId}`);
  }
  return row.proof_type;
}

function pickSubVerb(
  proofType: string,
  subVerbs: VerifyProofOptions["subVerbs"],
): { readonly name: string; readonly verb: SubVerb | undefined } {
  switch (proofType) {
    case "concept2_api+photo_fallback":
      return {
        name: "verifyConcept2OrPhoto",
        verb: subVerbs?.verifyConcept2OrPhoto,
      };
    case "training_log_photo":
      return {
        name: "verifyTrainingLogPhoto",
        verb: subVerbs?.verifyTrainingLogPhoto,
      };
    case "typed_msg+garmin_sleep":
      return {
        name: "verifyWindDownStageA",
        verb: subVerbs?.verifyWindDownStageA,
      };
    default:
      throw new Error(`Unknown proof_type: ${proofType}`);
  }
}

// -----------------------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------------------

export async function verifyProof(
  opts: VerifyProofOptions,
): Promise<VerifyProofResult> {
  const proofType = loadProofType(opts.db, opts.habitId);
  const { name, verb } = pickSubVerb(proofType, opts.subVerbs);

  if (verb === undefined) {
    throw new Error(`${name} not yet wired (Task 34/35/36)`);
  }

  return verb({
    sessionStore: opts.sessionStore,
    sessionId: opts.sessionId,
    habitId: opts.habitId,
    runId: opts.runId,
    message: opts.message,
    now: opts.now,
  });
}
