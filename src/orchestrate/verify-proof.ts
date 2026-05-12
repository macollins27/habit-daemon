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
import type { Attachment, Message } from "discord.js";
import type { SessionStore } from "../daemon/session-store.js";
import {
  syncDate as concept2SyncDate,
  type Concept2Credentials,
  type Concept2Result,
  type Concept2Tokens,
} from "../lib/concept2-adapter.js";
import {
  verifyImage,
  type DispatchResult as VisionDispatchResult,
} from "../lib/vision-verify.js";

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

// -----------------------------------------------------------------------------
// Task 34: verifyConcept2OrPhoto sub-verb.
// -----------------------------------------------------------------------------
//
// Sub-verb for `proof_type = concept2_api+photo_fallback` (morning-row).
//
// Flow (design § 4):
//   1. Sync today's Concept2 sessions into `sensor_signals` (idempotent on
//      (source='concept2', payload_date=YYYY-MM-DD)) — this both refreshes
//      the cache and gives us a stable read-back point.
//   2. Read the cached sensor_signals row and look for at least one rower
//      session with `duration_seconds >= proof_config.min_minutes * 60`.
//      If found → completed, proofPayload = {source: 'concept2', session}.
//   3. Otherwise, if `habit_run.current_level >= proof_config.fallback_required_at_level`
//      AND `ctx.message` carries at least one `image/*` attachment, dispatch
//      `verifyImage(subject='pm5_screen')` over the first image attachment.
//      Vision pass → completed (source='photo'). Vision fail → rejected.
//   4. Otherwise → pending (no claim made — caller does NOT bump
//      vision_rejection_count or flip habit_runs.status).
//
// The sub-verb performs NO `habit_runs.status` writes. The caller
// (production wire-up in Task 39+) translates the VerifyProofResult into
// the actual DB transition. The sub-verb DOES sync Concept2 results into
// `sensor_signals` because that's a cache write (idempotent, additive), not
// a state-machine transition.
//
// Phase A simplification: the design's `lookup_window_hours` (a narrow
// window around the morning-row time) is NOT applied here. We accept any
// qualifying rower session for the entire calendar date. Narrow-window
// filtering can be added in Phase B once the design has empirical data on
// false-positive rate (e.g., afternoon erg sessions for non-row habits).

interface ProofConfigMorningRow {
  readonly min_minutes: number;
  readonly lookup_window_hours: number;
  readonly fallback_required_at_level: number;
}

interface HabitConfigRow {
  readonly proof_config_json: string;
}

interface HabitRunLevelRow {
  readonly current_level: number;
}

interface SensorSignalPayloadRow {
  readonly payload_json: string;
}

interface Concept2Payload {
  readonly results: readonly Concept2Result[];
}

/**
 * Format a Date as YYYY-MM-DD in UTC. Mirrors the helper in
 * concept2-adapter.ts (kept private there). Concept2's `payload_date` is
 * UTC-truncated; we read the same row back, so we must format identically.
 */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function loadProofConfig(
  db: Database.Database,
  habitId: string,
): ProofConfigMorningRow {
  const row = db
    .prepare("SELECT proof_config_json FROM habits WHERE id = ?")
    .get(habitId) as HabitConfigRow | undefined;
  if (row === undefined) {
    throw new Error(`habit not found: ${habitId}`);
  }
  const parsed = JSON.parse(row.proof_config_json) as Record<string, unknown>;
  // Defensive: the seed guarantees these three fields exist for morning-row.
  // We still validate them here so a malformed row throws with a clear hint
  // rather than a cryptic NaN comparison downstream.
  const minMinutes = parsed.min_minutes;
  const lookupHours = parsed.lookup_window_hours;
  const fallbackLevel = parsed.fallback_required_at_level;
  if (
    typeof minMinutes !== "number" ||
    typeof lookupHours !== "number" ||
    typeof fallbackLevel !== "number"
  ) {
    throw new Error(
      `habit ${habitId} proof_config_json malformed (expected min_minutes, lookup_window_hours, fallback_required_at_level)`,
    );
  }
  return {
    min_minutes: minMinutes,
    lookup_window_hours: lookupHours,
    fallback_required_at_level: fallbackLevel,
  };
}

function loadRunLevel(db: Database.Database, runId: string): number {
  const row = db
    .prepare("SELECT current_level FROM habit_runs WHERE id = ?")
    .get(runId) as HabitRunLevelRow | undefined;
  if (row === undefined) {
    throw new Error(`habit_run not found: ${runId}`);
  }
  return row.current_level;
}

function loadCachedConcept2Results(
  db: Database.Database,
  date: string,
): readonly Concept2Result[] {
  const row = db
    .prepare(
      "SELECT payload_json FROM sensor_signals WHERE source = 'concept2' AND payload_date = ?",
    )
    .get(date) as SensorSignalPayloadRow | undefined;
  if (row === undefined) {
    return [];
  }
  const parsed = JSON.parse(row.payload_json) as Concept2Payload;
  return parsed.results;
}

/**
 * Pick the first rower session whose duration meets the min-minutes floor.
 * Phase A: only `type === 'rower'` qualifies (the design's "morning row"
 * habit is PM5-specific). Future rower types ('erg', 'skierg', etc.) are
 * intentionally excluded; revisit if the design adds cross-modal proof.
 */
function findQualifyingSession(
  results: readonly Concept2Result[],
  minMinutes: number,
): Concept2Result | undefined {
  const minSeconds = minMinutes * 60;
  return results.find(
    (r) => r.type === "rower" && r.duration_seconds >= minSeconds,
  );
}

/**
 * Find the first image attachment on the message, if any.
 *
 * `message.attachments` is a discord.js `Collection<string, Attachment>`,
 * which extends Map, so we iterate via the standard Map values() interface.
 * For tests we accept a plain Map shape (structurally compatible).
 */
function findImageAttachment(message: Message): Attachment | undefined {
  const attachments = message.attachments as unknown as {
    values: () => Iterable<Attachment>;
  };
  for (const att of attachments.values()) {
    const contentType = att.contentType;
    if (typeof contentType === "string" && contentType.startsWith("image/")) {
      return att;
    }
  }
  return undefined;
}

export interface VerifyConcept2OrPhotoDeps {
  readonly credentials: Concept2Credentials;
  readonly tokens: Concept2Tokens;
  /** Test seam. Production callers leave this unset. */
  readonly fetchImpl?: typeof fetch;
  /** Token-refresh persistence hook (forwarded to concept2-adapter). */
  readonly onTokensRefreshed?: (newTokens: Concept2Tokens) => void;
  /** Test seam for vision dispatch. Production falls through to the real chain. */
  readonly visionDispatchImpl?: (opts: {
    prompt: string;
    jsonSchema: string;
  }) => Promise<VisionDispatchResult>;
}

/**
 * Factory for the Concept2-with-photo-fallback sub-verb. The returned
 * SubVerb closes over the Concept2 credentials/tokens and vision dispatch
 * impl so the caller can hand the same configured verb instance to the
 * router across many invocations.
 */
export function makeVerifyConcept2OrPhoto(
  deps: VerifyConcept2OrPhotoDeps,
): SubVerb {
  return async function verifyConcept2OrPhoto(
    ctx: SubVerbContext,
  ): Promise<VerifyProofResult> {
    const db = ctx.sessionStore.db;

    // 1. Load config + current level (also serves as defensive existence checks).
    const proofConfig = loadProofConfig(db, ctx.habitId);
    const currentLevel = loadRunLevel(db, ctx.runId);

    // 2. Sync Concept2 for today's date (idempotent). This refreshes the
    //    cache; errors propagate so the caller can route to the unresolved
    //    sensor-failure path (Task 15).
    const today = new Date(ctx.now);
    const dateStr = toIsoDate(today);
    await concept2SyncDate({
      db,
      date: today,
      credentials: deps.credentials,
      tokens: deps.tokens,
      fetchImpl: deps.fetchImpl,
      onTokensRefreshed: deps.onTokensRefreshed,
    });

    // 3. Read the just-cached row and look for a qualifying session.
    const results = loadCachedConcept2Results(db, dateStr);
    const matched = findQualifyingSession(results, proofConfig.min_minutes);
    if (matched !== undefined) {
      return {
        outcome: "completed",
        proofPayload: { source: "concept2", session: matched },
      };
    }

    // 4. Photo fallback gate: requires sufficient level AND an image attachment.
    if (currentLevel < proofConfig.fallback_required_at_level) {
      return { outcome: "pending" };
    }
    const image = findImageAttachment(ctx.message);
    if (image === undefined) {
      return { outcome: "pending" };
    }

    // 5. Vision verification of the attached image.
    const visionResult = await verifyImage({
      imageUrl: image.url,
      subject: "pm5_screen",
      dispatchImpl: deps.visionDispatchImpl,
    });

    if (visionResult.passed) {
      return {
        outcome: "completed",
        proofPayload: { source: "photo", parsed: visionResult.parsed },
      };
    }
    return {
      outcome: "rejected",
      reason: visionResult.reason,
      proofPayload: { source: "photo", parsed: visionResult.parsed },
    };
  };
}
