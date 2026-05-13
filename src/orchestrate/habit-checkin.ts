// Task 24: habit-checkin orchestration verb — the first dispatch the
// scheduler makes for an active `habit_run`.
//
// Flow:
//   1. Load `habits` + `habit_runs` rows for the given runId.
//   2. Query the last 20 session_events whose payload has `habitId == this`.
//   3. Pick the level template (Task 24 only handles L1; L2-L5 land later).
//   4. Build the system prompt via the shared prompt-builder.
//   5. Dispatch via the injected `dispatchImpl` (production wires the real
//      `claude -p` substrate; tests pass a mock).
//   6. Validate `structured_output` against the L1 Zod schema.
//   7. Post the model's `message_text` to the habit's Discord channel via
//      the injected `postImpl` (defaults to the real `postToChannel`).
//   8. Inside ONE `sessionStore.db` transaction:
//        - UPDATE habit_runs SET current_level = currentLevel + 1,
//          next_escalation_at = now + per-habit delta;
//        - If proof_rejection_callout_due was 1, reset it to 0;
//        - Append a 'habit_prompt_sent' event with payload
//          {habitId, runId, level, messageText, calloutFired}.
//
// Single-writer constraint (Task 15 pattern): both the habit_runs UPDATE
// and the session_events append run on `sessionStore.db` inside one
// better-sqlite3 transaction (SAVEPOINT-composing). The verb does NOT
// accept a separate `db` handle.
//
// Atomicity: dispatch and post happen BEFORE the DB transaction. If either
// fails, no DB writes occur. The DB writes are wrapped in a single tx so
// a session_events append failure rolls the habit_runs UPDATE back. The
// model's suggested `next_check_in_iso` is intentionally ignored — the
// verb computes `nextEscalationAt` from a per-habit table (design § 3).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 24
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (cadence)
//   - src/lib/prompt-builder.ts (shared composer)
//   - src/lib/prompt-templates/level-1.ts (L1 voice + schema)
//   - src/orchestrate/vision-rejection-counter.ts (sets the callout flag)

import { z } from "zod";
import type Database from "better-sqlite3";
import type { SessionStore, SessionEventRow } from "../daemon/session-store.js";
import {
  postToChannel,
  type ChannelName,
  type DiscordAdapter,
} from "../lib/discord-adapter.js";
import {
  buildHabitCheckinPrompt,
  type HabitContext,
  type RunContext,
  type LevelTemplate,
} from "../lib/prompt-builder.js";
import { LEVEL_1_TEMPLATE } from "../lib/prompt-templates/level-1.js";
import { LEVEL_2_TEMPLATE } from "../lib/prompt-templates/level-2.js";
import { buildL3StakesTemplate } from "../lib/prompt-templates/level-3-stakes.js";
import { buildL3BodyDataTemplate } from "../lib/prompt-templates/level-3-body-data.js";
import { buildL3PatternTemplate } from "../lib/prompt-templates/level-3-pattern.js";
import { LEVEL_4_TEMPLATE } from "../lib/prompt-templates/level-4.js";
import { LEVEL_5_TEMPLATE } from "../lib/prompt-templates/level-5.js";
import {
  selectWell,
  type MissReason,
  type SensorSignal,
  type StakeName,
  type WellSelection,
} from "../lib/why-well-selector.js";
import { checkProvable } from "./check-provable.js";
import { formatMorningRowSummary } from "./reconcile-pending-runs.js";
import type { Concept2Result } from "../lib/concept2-adapter.js";
import { localDateString } from "../lib/local-date.js";

// -----------------------------------------------------------------------------
// Per-habit escalation cadence (design § 3).
//
// L1→L2 delta minutes by habit. The fromLevel passed to
// `getEscalationDeltaMinutes` is the level that is CURRENTLY firing — i.e.,
// to schedule L2 we ask for delta(habitId, 1). Encoded for L1..L4 here so
// later tasks (L2/L3/L4 templates) can reuse the same table. wind-down has
// no L4→L5 entry because design § 3 says L4 is its terminal level.
//
// User-created habits (id = `habit_<slug>` per createHabit) are NOT in this
// per-habit map. They fall through to `DEFAULT_ESCALATION_DELTA_MINUTES`
// below — without that fallback the first scheduler tick on any user-created
// habit throws inside this verb. Same shape as the channel-routing bug
// fixed in commit 319305f: a closed map keyed on the three Phase-A seed
// habit ids was load-bearing for arbitrary user slugs.
// -----------------------------------------------------------------------------

const ESCALATION_DELTA_MINUTES: Readonly<
  Record<string, Readonly<Record<number, number | null>>>
> = {
  "morning-row": { 1: 30, 2: 30, 3: 30, 4: 30, 5: null },
  "strength-mwf": { 1: 30, 2: 30, 3: 30, 4: 30, 5: null },
  // wind-down has no L4 or L5 entry — design § 3 closes the window at L4
  // (Task 36/37 owns terminal-state evaluation). Keeping the table sparse
  // preserves the existing fail-fast contract for (wind-down, fromLevel>=4).
  "wind-down": { 1: 8, 2: 5, 3: 2 },
} as const;

// Default escalation cadence for any habit not enumerated above (user-created
// habits + any future habit added without its own row). Same shape as the
// per-habit tables: keys are the level that is CURRENTLY firing; the value is
// the minutes-to-wait before the next escalation. `null` at L5 signals the
// terminal step — `runHabitCheckin` separately interprets currentLevel===5 as
// terminal and writes `next_escalation_at = NULL`, so this null is documented
// rather than load-bearing on the happy path.
const DEFAULT_ESCALATION_DELTA_MINUTES: Readonly<
  Record<number, number | null>
> = {
  1: 10,
  2: 15,
  3: 30,
  4: 60,
  5: null,
} as const;

export function getEscalationDeltaMinutes(
  habitId: string,
  fromLevel: number,
): number | null {
  const habitMap = ESCALATION_DELTA_MINUTES[habitId];
  if (habitMap !== undefined) {
    const delta = habitMap[fromLevel];
    if (delta === undefined) {
      // Known habit with an explicit gap in the table — e.g. wind-down has
      // no L4 entry per design § 3. Fail-fast preserves Task 30's contract
      // that an unsupported (habit, level) combination throws atomically.
      throw new Error(
        `No escalation delta defined for habit=${habitId} fromLevel=${fromLevel}`,
      );
    }
    return delta;
  }
  // Unknown habit id — user-created habit or any future addition without its
  // own row. Fall back to the default cadence. `null` at L5 signals terminal.
  const defaultDelta = DEFAULT_ESCALATION_DELTA_MINUTES[fromLevel];
  if (defaultDelta === undefined) {
    throw new Error(
      `No default escalation delta defined for fromLevel=${fromLevel}`,
    );
  }
  return defaultDelta;
}

// -----------------------------------------------------------------------------
// Channel routing: habit row → ChannelName | raw snowflake id.
//
// Phase A seed habits (morning-row, strength-mwf, wind-down) have a `domain`
// in the closed set below and route through the named-channel registry
// (`adapter.channelIds[name]`). User-created habits (from `createHabit`) use
// their slug as `domain` — not in the map — and carry the destination Discord
// snowflake directly on `habits.channel_id`. For those rows we fall back to
// the raw snowflake; `postToChannel` accepts `ChannelName | string` and
// resolves either to a snowflake before calling `client.channels.fetch`.
//
// Why this matters: without the fallback, the first scheduler tick on any
// user-created habit throws inside this verb because no DOMAIN_TO_CHANNEL
// entry exists for arbitrary user slugs. The fallback is load-bearing for
// chat/web-UI habit creation.
// -----------------------------------------------------------------------------

const DOMAIN_TO_CHANNEL: Readonly<Record<string, ChannelName>> = {
  row: "morning-row",
  strength: "strength",
  "wind-down": "wind-down",
};

export interface ChannelRoutingHabit {
  readonly domain: string;
  readonly channel_id: string;
}

/**
 * Resolve a habit row to the value that should be passed as
 * `postToChannel.channel`. Phase-A seed habits return a `ChannelName` looked
 * up via `DOMAIN_TO_CHANNEL`; user-created habits (any domain outside the
 * closed map) return the raw `habit.channel_id` snowflake.
 *
 * Exported for regression-test coverage — production callers reach it
 * implicitly through `runHabitCheckin`.
 */
export function channelForHabit(
  habit: ChannelRoutingHabit,
): ChannelName | string {
  const name = DOMAIN_TO_CHANNEL[habit.domain];
  if (name !== undefined) {
    return name;
  }
  // User-created habit (domain == slug, not in the Phase-A map). The row's
  // `channel_id` IS the Discord snowflake — postToChannel passes it straight
  // through to `client.channels.fetch`.
  return habit.channel_id;
}

// -----------------------------------------------------------------------------
// Output-schema validation. Mirrors the JSON Schema emitted by every level
// template (L1 + L2 share the same {message_text, next_check_in_iso} shape).
// Kept as a sibling Zod instead of imported from the templates because each
// template exposes only the JSON Schema string — the validator stays inside
// the verb so the verb owns the post-dispatch parse contract.
// -----------------------------------------------------------------------------

const CHECKIN_OUTPUT_VALIDATION_SCHEMA = z.object({
  message_text: z.string().min(1),
  next_check_in_iso: z.string(),
});

// -----------------------------------------------------------------------------
// DI seams.
// -----------------------------------------------------------------------------

export interface DispatchResult {
  readonly structured_output?: unknown;
  readonly error?: string;
}

export type DispatchImpl = (opts: {
  prompt: string;
  jsonSchema: string;
}) => Promise<DispatchResult>;

export interface PostImplOptions {
  readonly adapter: DiscordAdapter;
  // `ChannelName` for Phase-A seed habits routed by name through
  // `adapter.channelIds`; a raw Discord snowflake string for user-created
  // habits whose `habits.channel_id` column carries the snowflake directly.
  // See `channelForHabit` above and `postToChannel`'s resolver in
  // `src/lib/discord-adapter.ts`.
  readonly channel: ChannelName | string;
  readonly content: string;
}

export type PostImpl = (
  opts: PostImplOptions,
) => Promise<{ readonly messageId: string }>;

async function defaultPostImpl(
  opts: PostImplOptions,
): Promise<{ readonly messageId: string }> {
  const result = await postToChannel({
    adapter: opts.adapter,
    channel: opts.channel,
    content: opts.content,
  });
  return { messageId: result.messageId };
}

// -----------------------------------------------------------------------------
// Public API.
// -----------------------------------------------------------------------------

export interface HabitCheckinOptions {
  readonly sessionStore: SessionStore;
  readonly adapter: DiscordAdapter;
  readonly sessionId: string;
  readonly runId: string;
  readonly currentLevel: number;
  /** Epoch ms — injected for testability. */
  readonly now: number;
  readonly dispatchImpl?: DispatchImpl;
  readonly postImpl?: PostImpl;
}

export interface HabitCheckinResult {
  readonly dispatched: boolean;
  readonly messagePosted: boolean;
  readonly newLevel: number;
  readonly nextEscalationAt: number | null;
  readonly calloutFired: boolean;
}

interface HabitRowRaw {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly cron_expr: string;
  readonly why_stakes_json: string;
  readonly proof_type: string;
  readonly proof_config_json: string;
  readonly channel_id: string;
}

interface RunRowRaw {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
  readonly fired_at: number;
  readonly current_level: number;
  readonly status: string;
  readonly proof_rejection_callout_due: number;
  readonly last_escalation_message_id: string | null;
}

// -----------------------------------------------------------------------------
// Phase 6.2: shared follow-up text for autonomous-close paths.
//
// When a run is closed by an autonomous path (reconciler, this short-circuit,
// or handle-proof-message's applyCompleted) AND a prior escalation was tracked
// (`habit_runs.last_escalation_message_id` is non-null), the daemon posts this
// brief follow-up in the source channel so the orphaned escalation gets
// closure pointing at the #wins summary that follows.
//
// Exported for cross-path consistency — all three call sites pass this exact
// string to postToChannel, and the test suite asserts on the constant.
// -----------------------------------------------------------------------------

export const ESCALATION_FOLLOW_UP_CONTENT = "✓ Proof is in — see #wins.";

// -----------------------------------------------------------------------------
// Defensive guard helpers (Task 38).
//
// Design § 3 requires two enforcement mechanisms so morning-row L1 never
// dispatches before wind-down stage-B has been evaluated:
//   1. `dispatch_priority` on `schedules` — the scheduler tick sorts so
//      stage-B (priority=10) runs before morning-row (priority=100). Wired
//      by Task 16 + Task 32 in `schedule-tick`.
//   2. A defensive guard inside this verb: if invoked for morning-row at L1
//      while wind-down stage-B is still status='partial' from the previous
//      night, defer self by 60s without dispatching.
//
// The guard runs AFTER habit+run+currentLevel load (so atomicity is preserved
// for unknown runId) but BEFORE template selection, recent-event loading, and
// any model dispatch. Its only side effect on the partial-wind-down path is a
// single-row UPDATE of habit_runs.next_escalation_at — no session_events
// append, no Discord post, no proof_rejection_callout_due reset.
// -----------------------------------------------------------------------------

const DEFENSIVE_GUARD_DEFER_MS = 60 * 1000;

interface PartialWindDownRow {
  readonly _: 1;
}

function shouldDeferForPartialWindDown(
  db: Database.Database,
  habitId: string,
  currentLevel: number,
  now: number,
): boolean {
  if (habitId !== "morning-row") return false;
  if (currentLevel !== 1) return false;
  const yesterday = localDateString(now - 24 * 60 * 60 * 1000);
  const row = db
    .prepare(
      `SELECT 1 AS _
         FROM habit_runs
        WHERE habit_id = 'wind-down'
          AND status = 'partial'
          AND fire_date = ?
        LIMIT 1`,
    )
    .get(yesterday) as PartialWindDownRow | undefined;
  return row !== undefined;
}

function deferForPartialWindDown(
  db: Database.Database,
  runId: string,
  now: number,
): number {
  const deferredAt = now + DEFENSIVE_GUARD_DEFER_MS;
  db.prepare(
    `UPDATE habit_runs
        SET next_escalation_at = ?
      WHERE id = ?`,
  ).run(deferredAt, runId);
  return deferredAt;
}

function parseJsonRecord(s: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${label} JSON: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function selectLevelTemplate(
  currentLevel: number,
  opts?: { readonly wellSelection?: WellSelection },
): LevelTemplate {
  switch (currentLevel) {
    case 1:
      return LEVEL_1_TEMPLATE;
    case 2:
      return LEVEL_2_TEMPLATE;
    case 3: {
      if (opts?.wellSelection === undefined) {
        throw new Error(
          "habit-checkin L3 requires a wellSelection (caller bug)",
        );
      }
      switch (opts.wellSelection.well) {
        case "stakes":
          return buildL3StakesTemplate(opts.wellSelection);
        case "body_data":
          return buildL3BodyDataTemplate(opts.wellSelection);
        case "pattern":
          return buildL3PatternTemplate(opts.wellSelection);
      }
      // Exhaustive switch — TypeScript should never let us get here.
      throw new Error(
        `habit-checkin L3 unsupported well selection: ${JSON.stringify(opts.wellSelection)}`,
      );
    }
    case 4:
      return LEVEL_4_TEMPLATE;
    case 5:
      return LEVEL_5_TEMPLATE;
    default:
      throw new Error(
        `habit-checkin currentLevel=${currentLevel} is not supported yet (L1-L5 wired)`,
      );
  }
}

// -----------------------------------------------------------------------------
// L3 selector-context loaders.
//
// These queries are scoped to the trailing 30-day window the selector cares
// about. They are pure SQL — no side effects — and run BEFORE dispatch so a
// load failure throws atomically without touching habit_runs / session_events.
// -----------------------------------------------------------------------------

const SELECTOR_LOOKBACK_DAYS = 30;
const SELECTOR_LOOKBACK_MS = SELECTOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

interface MissReasonRow {
  readonly id: string;
  readonly habit_id: string;
  readonly run_id: string;
  readonly miss_date: string;
  readonly inferred_specifics: string | null;
  readonly classification: string | null;
  readonly created_at: number;
}

interface SensorSignalRow {
  readonly id: string;
  readonly source: string;
  readonly payload_date: string;
  readonly payload_json: string;
  readonly fetched_at: number;
}

function loadMissReasons30d(
  sessionStore: SessionStore,
  habitId: string,
  now: number,
): readonly MissReason[] {
  const since = now - SELECTOR_LOOKBACK_MS;
  const rows = sessionStore.db
    .prepare(
      `SELECT id, habit_id, run_id, miss_date, inferred_specifics,
              classification, created_at
         FROM miss_reasons
        WHERE habit_id = ?
          AND created_at >= ?
        ORDER BY created_at ASC`,
    )
    .all(habitId, since) as readonly MissReasonRow[];

  return rows.map((r) => ({
    id: r.id,
    habit_id: r.habit_id,
    run_id: r.run_id,
    miss_date: r.miss_date,
    inferred_specifics: r.inferred_specifics,
    classification: r.classification,
    created_at: r.created_at,
  }));
}

/**
 * Load the most recent sensor_signals payload for the given source (parsed).
 * Returns null if no row exists OR if the payload is unparseable. Used by
 * runHabitCheckin to feed last-night Garmin + latest Concept2 session into
 * the prompt so the L1 model can cite real numbers.
 */
function loadLatestSensorPayload(
  sessionStore: SessionStore,
  source: "garmin" | "concept2",
): Record<string, unknown> | null {
  const row = sessionStore.db
    .prepare(
      `SELECT payload_json, payload_date, fetched_at
         FROM sensor_signals
        WHERE source = ?
        ORDER BY payload_date DESC, fetched_at DESC
        LIMIT 1`,
    )
    .get(source) as { payload_json: string; payload_date: string; fetched_at: number } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // Augment with the metadata so the model knows when this data was captured.
    return {
      ...(parsed as Record<string, unknown>),
      _payload_date: row.payload_date,
      _fetched_at_iso: new Date(row.fetched_at).toISOString(),
    };
  } catch {
    return null;
  }
}

function loadGarminSignals30d(
  sessionStore: SessionStore,
  now: number,
): readonly SensorSignal[] {
  const since = now - SELECTOR_LOOKBACK_MS;
  const rows = sessionStore.db
    .prepare(
      `SELECT id, source, payload_date, payload_json, fetched_at
         FROM sensor_signals
        WHERE source = 'garmin'
          AND fetched_at >= ?
        ORDER BY fetched_at DESC`,
    )
    .all(since) as readonly SensorSignalRow[];

  return rows.map((r) => ({
    id: r.id,
    // `source` is open per migration 002, but the selector union narrows it.
    source: r.source === "concept2" ? "concept2" : "garmin",
    payload_date: r.payload_date,
    payload_json: r.payload_json,
    fetched_at: r.fetched_at,
  }));
}

interface LastWellEventRow {
  readonly event_json: string;
  readonly written_iso: string;
}

function loadLastPatternWellUseMs(
  sessionStore: SessionStore,
  habitId: string,
): number | null {
  const row = sessionStore.db
    .prepare(
      `SELECT event_json, written_iso
         FROM session_events
        WHERE event_type = 'habit_prompt_sent'
          AND json_extract(event_json, '$.habitId') = ?
          AND json_extract(event_json, '$.well') = 'pattern'
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(habitId) as LastWellEventRow | undefined;

  if (row === undefined) return null;
  const ms = Date.parse(row.written_iso);
  return Number.isFinite(ms) ? ms : null;
}

function loadLastStakesWellUse(
  sessionStore: SessionStore,
  habitId: string,
): { readonly stake: StakeName; readonly usedAtMs: number } | null {
  const row = sessionStore.db
    .prepare(
      `SELECT event_json, written_iso
         FROM session_events
        WHERE event_type = 'habit_prompt_sent'
          AND json_extract(event_json, '$.habitId') = ?
          AND json_extract(event_json, '$.well') = 'stakes'
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(habitId) as LastWellEventRow | undefined;

  if (row === undefined) return null;
  const usedAtMs = Date.parse(row.written_iso);
  if (!Number.isFinite(usedAtMs)) return null;

  let stakeRaw: unknown;
  try {
    const parsed = JSON.parse(row.event_json) as Record<string, unknown>;
    stakeRaw = parsed["stake"];
  } catch {
    return null;
  }
  if (
    stakeRaw !== "primary" &&
    stakeRaw !== "secondary" &&
    stakeRaw !== "tertiary"
  ) {
    return null;
  }
  return { stake: stakeRaw, usedAtMs };
}

interface RecentEventsRow {
  readonly id: number;
  readonly session_id: string;
  readonly seq: number;
  readonly event_json: string;
  readonly prev_hash: string | null;
  readonly hash: string;
  readonly trust_level: string;
  readonly event_type: string | null;
  readonly written_iso: string;
}

function loadRecentEventsForHabit(
  sessionStore: SessionStore,
  habitId: string,
): readonly SessionEventRow[] {
  // Events that touch this habit carry `habitId` inside event_json (the same
  // convention vision-rejection-counter and resolve-sensor-failure use). We
  // pull the 20 most recent by id DESC; the prompt-builder renders them
  // newest-first.
  const rows = sessionStore.db
    .prepare(
      `SELECT id, session_id, seq, event_json, prev_hash, hash, trust_level,
              event_type, written_iso
         FROM session_events
        WHERE json_extract(event_json, '$.habitId') = ?
        ORDER BY id DESC
        LIMIT 20`,
    )
    .all(habitId) as readonly RecentEventsRow[];

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    eventJson: r.event_json,
    prevHash: r.prev_hash,
    hash: r.hash,
    trustLevel: r.trust_level as SessionEventRow["trustLevel"],
    eventType: r.event_type as SessionEventRow["eventType"],
    writtenIso: r.written_iso,
  }));
}

export async function runHabitCheckin(
  opts: HabitCheckinOptions,
): Promise<HabitCheckinResult> {
  const {
    sessionStore,
    adapter,
    sessionId,
    runId,
    currentLevel,
    now,
  } = opts;
  const dispatchImpl = opts.dispatchImpl ?? defaultDispatchImplNotProvided;
  const postImpl = opts.postImpl ?? defaultPostImpl;
  const db = sessionStore.db;

  // ---------------------------------------------------------------------------
  // 1. Load run + habit. Throw atomically (before any side effect) if missing.
  // ---------------------------------------------------------------------------
  const runRow = db
    .prepare(
      `SELECT id, habit_id, fire_date, fired_at, current_level, status,
              proof_rejection_callout_due, last_escalation_message_id
         FROM habit_runs
        WHERE id = ?`,
    )
    .get(runId) as RunRowRaw | undefined;

  if (runRow === undefined) {
    throw new Error(`habit_run not found: ${runId}`);
  }

  const habitRow = db
    .prepare(
      `SELECT id, name, domain, cron_expr, why_stakes_json, proof_type,
              proof_config_json, channel_id
         FROM habits
        WHERE id = ?`,
    )
    .get(runRow.habit_id) as HabitRowRaw | undefined;

  if (habitRow === undefined) {
    throw new Error(`habit not found for run=${runId}: ${runRow.habit_id}`);
  }

  // ---------------------------------------------------------------------------
  // 2. Compose contexts.
  // ---------------------------------------------------------------------------
  const habit: HabitContext = {
    id: habitRow.id,
    name: habitRow.name,
    domain: habitRow.domain,
    cron_expr: habitRow.cron_expr,
    proof_type: habitRow.proof_type,
    proof_config: parseJsonRecord(habitRow.proof_config_json, "proof_config"),
    why_stakes: parseJsonRecord(habitRow.why_stakes_json, "why_stakes"),
  };

  const run: RunContext = {
    id: runRow.id,
    fire_date: runRow.fire_date,
    current_level: runRow.current_level,
    status: runRow.status,
    fired_at: runRow.fired_at,
    proof_rejection_callout_due: runRow.proof_rejection_callout_due,
  };

  const calloutFired = run.proof_rejection_callout_due === 1;

  // ---------------------------------------------------------------------------
  // 2.5. Short-circuit when proof is already in cache (Task 2.2).
  //
  // If `checkProvable` finds a qualifying sensor row already on file for
  // (habit, fire_date) — e.g. Concept2 picked up the user's row that
  // happened before the escalation tick — close the run NOW. No dispatch,
  // no escalation. The Phase 1 reconciler covers the same path on its
  // 2-minute cron; this short-circuit makes the close immediate when
  // habit-checkin races ahead of the reconciler.
  //
  // Layering: this block runs BEFORE the defensive defer guard (§ 2a). If
  // proof is already on file, closing the run takes precedence over
  // deferring for partial wind-down — the user already did the thing,
  // there is nothing to defer.
  //
  // Posts to Discord (source channel + #wins) happen AFTER the transaction
  // commits, mirroring the Phase 1 reconciler's dual-channel pattern. Each
  // post gets its own try/catch so a flaky channel cannot abort the other
  // post or leave the run in an inconsistent state — the DB write is
  // already committed by then.
  // ---------------------------------------------------------------------------
  const provable = checkProvable({
    db,
    habitId: habit.id,
    fireDate: run.fire_date,
  });
  if (provable.provable) {
    const proofPayload = {
      source: provable.source,
      session: provable.payload,
      autoDetected: true,
    };
    db.transaction(() => {
      db.prepare(
        `UPDATE habit_runs
            SET status = 'completed',
                completed_at = ?,
                next_escalation_at = NULL,
                proof_payload_json = ?
          WHERE id = ?`,
      ).run(now, JSON.stringify({ proof: proofPayload }), run.id);
      sessionStore.append(
        sessionId,
        "habit_completed",
        {
          habitId: habit.id,
          runId: run.id,
          completedAt: now,
          proofPayload,
        },
        { trustLevel: "L1" },
      );
    })();

    // Post to source channel + #wins, mirroring the reconciler's
    // dual-channel pattern. Each call gets its own try/catch so a failing
    // post can't abort the other or leave the run in an inconsistent state.
    //
    // Only Concept2 has a typed session payload right now (checkProvable's
    // Garmin branch is deferred). When that lands, this block becomes a
    // switch.
    if (provable.source === "concept2") {
      // Phase 6.2: if a prior escalation was tracked for this run, post a
      // brief follow-up FIRST so the orphaned escalation gets closure
      // pointing at the #wins summary that follows. Its own try/catch — a
      // flaky channel here must not block the closure summary posts below.
      if (runRow.last_escalation_message_id !== null) {
        try {
          await postToChannel({
            adapter: opts.adapter,
            channel: habitRow.channel_id,
            content: ESCALATION_FOLLOW_UP_CONTENT,
          });
        } catch (err: unknown) {
          console.error(
            `[habit-checkin] escalation follow-up post failed for run ${run.id}:`,
            err,
          );
        }
      }

      const summary = formatMorningRowSummary(
        provable.payload as unknown as Concept2Result,
      );
      try {
        await postToChannel({
          adapter: opts.adapter,
          channel: habitRow.channel_id,
          content: summary,
        });
      } catch (err: unknown) {
        console.error(
          `[habit-checkin] source-channel ack failed for run ${run.id}:`,
          err,
        );
      }
      try {
        await postToChannel({
          adapter: opts.adapter,
          channel: "wins",
          content: summary,
        });
      } catch (err: unknown) {
        console.error(
          `[habit-checkin] wins post failed for run ${run.id}:`,
          err,
        );
      }
    }

    return {
      dispatched: false,
      messagePosted: false,
      newLevel: currentLevel,
      nextEscalationAt: null,
      calloutFired: false,
    };
  }

  // ---------------------------------------------------------------------------
  // 2a. Defensive guard (Task 38, design § 3).
  //
  // For morning-row at L1 only: if wind-down stage-B is still status='partial'
  // from yesterday, defer this verb by 60s. This is belt + suspenders with the
  // scheduler's dispatch_priority ordering (stage-B priority=10, row L1
  // priority=100). If the scheduler ordering is bypassed (timing race, missed
  // cron, manual invocation), the guard absorbs the call so stage-B has
  // another minute to complete.
  //
  // The guard runs BEFORE template selection, cadence resolution, and any
  // dispatch — so deferral is side-effect-free except for the single-row
  // UPDATE of habit_runs.next_escalation_at. No session_events row is written
  // for a deferral; the scheduler simply retries 60s later via the normal
  // next_escalation_at path.
  // ---------------------------------------------------------------------------
  if (shouldDeferForPartialWindDown(db, habit.id, currentLevel, now)) {
    const deferredAt = deferForPartialWindDown(db, runId, now);
    process.stderr.write(
      `[habit-checkin] morning-row L1 deferred 60s for runId=${runId} ` +
        `(wind-down stage-B partial from previous night)\n`,
    );
    return {
      dispatched: false,
      messagePosted: false,
      newLevel: currentLevel,
      nextEscalationAt: deferredAt,
      calloutFired: false,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Pick template + load recent events + build prompt.
  //
  //    For L3 we first run the WHY-well selector (pattern > body_data >
  //    stakes) over trailing 30-day miss_reasons / sensor_signals and the
  //    last-use stamps mined from session_events. The selector is a pure
  //    function; all DB I/O happens in the loaders above.
  // ---------------------------------------------------------------------------
  let wellSelection: WellSelection | undefined;
  if (currentLevel === 3) {
    const missReasons30d = loadMissReasons30d(sessionStore, habit.id, now);
    const sensorSignals = loadGarminSignals30d(sessionStore, now);
    const lastPatternWellUseMs = loadLastPatternWellUseMs(
      sessionStore,
      habit.id,
    );
    const lastStakesWellUse = loadLastStakesWellUse(sessionStore, habit.id);
    wellSelection = selectWell({
      habit,
      run,
      now,
      missReasons30d,
      sensorSignals,
      lastPatternWellUseMs,
      lastStakesWellUse,
    });
  }

  const levelTemplate = selectLevelTemplate(currentLevel, { wellSelection });

  // L5 is the TERMINAL escalation step for morning-row / strength-mwf —
  // after dispatch the run flips to status='missed' and next_escalation_at
  // becomes NULL. wind-down has no L5 (design § 3 says wind-down closes at
  // L4); fail-fast here so the verb is side-effect-free for unsupported
  // (habit, level=5) combinations. Task 36/37 owns wind-down's L4 terminal
  // state evaluation — that lives in a different verb.
  const isTerminalLevel = currentLevel === 5;
  if (isTerminalLevel && habit.id === "wind-down") {
    throw new Error(
      "habit-checkin L5 is not supported for wind-down (terminates at L4)",
    );
  }

  // Fail-fast cadence lookup: resolve the (habit, level) → delta minutes
  // entry BEFORE we dispatch the model or post to Discord. Both
  // selectLevelTemplate above and getEscalationDeltaMinutes here throw for
  // unsupported (habit, level) combinations (e.g. wind-down L4); doing both
  // lookups upfront keeps the verb side-effect-free when an invalid combo
  // is asked for. The resolved delta is reused below to compute
  // nextEscalationAt — single call, single source of truth.
  //
  // L5 skips the lookup entirely: there is no L5→L6 entry in the cadence
  // table because L5 is terminal. The DB transaction sets
  // next_escalation_at = NULL directly.
  //
  // `getEscalationDeltaMinutes` returns `number | null` so that callers can
  // distinguish "no further escalation" (null) from a real delta. On the
  // non-terminal branch we narrow null → throw, because L1..L4 must always
  // resolve to a real cadence — null at L1..L4 indicates a misconfigured
  // habit row that the verb should refuse atomically.
  let deltaMinutes: number;
  if (isTerminalLevel) {
    deltaMinutes = 0;
  } else {
    const resolved = getEscalationDeltaMinutes(habit.id, currentLevel);
    if (resolved === null) {
      throw new Error(
        `habit-checkin: getEscalationDeltaMinutes returned null at ` +
          `non-terminal level for habit=${habit.id} fromLevel=${currentLevel}`,
      );
    }
    deltaMinutes = resolved;
  }

  const recentEvents = loadRecentEventsForHabit(sessionStore, habit.id);

  // Always-on context for the model: last night's Garmin payload, the most
  // recent Concept2 session, and recent miss_reasons. The model is given
  // raw JSON and trusted to cite specific fields per the L1 voice rules
  // (which forbid invented numbers). This data is what makes L1 hit on
  // the first message instead of reading like a generic notification.
  const garminLastNight = loadLatestSensorPayload(sessionStore, "garmin");
  const concept2LastSession = loadLatestSensorPayload(sessionStore, "concept2");
  const recentMissesSnapshot = {
    misses: loadMissReasons30d(sessionStore, habit.id, now).map((m) => ({
      miss_date: m.miss_date,
      classification: m.classification,
      inferred_specifics: m.inferred_specifics,
    })),
  };

  const prompt = buildHabitCheckinPrompt({
    habit,
    run,
    currentLevel,
    recentEvents,
    levelTemplate,
    sensorSnapshot: {
      garminLastNight,
      concept2LastSession,
    },
    recentMisses: recentMissesSnapshot,
  });

  // ---------------------------------------------------------------------------
  // 4. Dispatch (no DB side effect yet).
  // ---------------------------------------------------------------------------
  const dispatchResult = await dispatchImpl({
    prompt,
    jsonSchema: levelTemplate.outputSchema,
  });

  if (dispatchResult.error !== undefined) {
    throw new Error(`habit-checkin dispatch failed: ${dispatchResult.error}`);
  }
  if (dispatchResult.structured_output === undefined) {
    throw new Error("habit-checkin dispatch returned no structured_output");
  }

  // ---------------------------------------------------------------------------
  // 5. Validate the model's output against the shared check-in schema.
  // ---------------------------------------------------------------------------
  const parsed = CHECKIN_OUTPUT_VALIDATION_SCHEMA.safeParse(
    dispatchResult.structured_output,
  );
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`habit-checkin schema validation failed: ${issues}`);
  }

  const messageText = parsed.data.message_text;

  // ---------------------------------------------------------------------------
  // 6. Post to channel BEFORE the DB transaction. If the post throws, no DB
  //    writes have happened — the run stays at its current level so the next
  //    scheduler tick retries.
  // ---------------------------------------------------------------------------
  const channelName = channelForHabit({
    domain: habit.domain,
    channel_id: habitRow.channel_id,
  });
  const postResult = await postImpl({
    adapter,
    channel: channelName,
    content: messageText,
  });

  // Phase 6.1: record the Discord message id of this escalation so the
  // completion path can post a follow-up referencing it when a later
  // autonomous close supersedes the escalation. Fire-and-forget — wrap in
  // try/catch so a stray DB error never tanks the verb. The post already
  // succeeded; not recording the id only weakens the follow-up UX.
  try {
    db.prepare(
      `UPDATE habit_runs
          SET last_escalation_message_id = ?
        WHERE id = ?`,
    ).run(postResult.messageId, runId);
  } catch (err: unknown) {
    console.error(
      `[habit-checkin] failed to record last_escalation_message_id for run ${runId}:`,
      err,
    );
  }

  // ---------------------------------------------------------------------------
  // 7. Persist atomic state changes.
  //
  //    `deltaMinutes` was resolved upfront (fail-fast at step 3) — the
  //    model's suggested next_check_in_iso is ignored in Phase A (design
  //    § 3 owns cadence).
  //
  //    L5 is terminal: current_level stays at 5, next_escalation_at = NULL,
  //    status flips to 'missed'. L1-L4 advance current_level + 1 and
  //    compute next_escalation_at from the per-habit cadence. The event
  //    payload carries `terminal: true` at L5 so downstream queries can
  //    locate the closing event without re-walking the chain.
  // ---------------------------------------------------------------------------
  const nextEscalationAt = isTerminalLevel
    ? null
    : now + deltaMinutes * 60 * 1000;
  const newLevel = isTerminalLevel ? currentLevel : currentLevel + 1;

  const persist = db.transaction(() => {
    if (isTerminalLevel) {
      db.prepare(
        `UPDATE habit_runs
            SET current_level = ?, next_escalation_at = NULL, status = 'missed'
          WHERE id = ?`,
      ).run(newLevel, runId);
    } else {
      db.prepare(
        `UPDATE habit_runs
            SET current_level = ?, next_escalation_at = ?
          WHERE id = ?`,
      ).run(newLevel, nextEscalationAt, runId);
    }

    if (calloutFired) {
      db.prepare(
        `UPDATE habit_runs
            SET proof_rejection_callout_due = 0
          WHERE id = ?`,
      ).run(runId);
    }

    // The L3 dispatch carries `well` (+ `stake` when stakes is chosen, +
    // `anomalousSignals` for body_data, + `slugPrefix`/`patternCount` for
    // pattern) so the next L3 invocation can find this usage via
    // json_extract and rotate / dedup. L1/L2/L4 omit these fields entirely;
    // L5 adds `terminal: true` so Phase B's post-miss interview engine and
    // the Sunday-review query can locate the closing event without
    // re-walking the chain. aat-chain.jsonCanonicalize rejects `undefined`
    // keys, so each optional field is conditionally spread (the same
    // pattern Task 19's vision-rejection-counter uses).
    const eventPayload: Record<string, unknown> = {
      habitId: habit.id,
      runId,
      level: currentLevel,
      messageText,
      calloutFired,
      ...(isTerminalLevel ? { terminal: true } : {}),
      ...(wellSelection !== undefined ? { well: wellSelection.well } : {}),
      ...(wellSelection !== undefined && wellSelection.well === "stakes"
        ? { stake: wellSelection.stake }
        : {}),
      ...(wellSelection !== undefined && wellSelection.well === "body_data"
        ? { anomalousSignals: wellSelection.anomalousSignals }
        : {}),
      ...(wellSelection !== undefined && wellSelection.well === "pattern"
        ? {
            slugPrefix: wellSelection.slugPrefix,
            patternCount: wellSelection.count,
          }
        : {}),
    };

    sessionStore.append(sessionId, "habit_prompt_sent", eventPayload, {
      trustLevel: "L1",
    });
  });

  persist();

  return {
    dispatched: true,
    messagePosted: true,
    newLevel,
    nextEscalationAt,
    calloutFired,
  };
}

// -----------------------------------------------------------------------------
// Production callers MUST supply a dispatchImpl (the daemon entrypoint wires
// the real `claude -p` substrate). Failing loud here prevents a silent
// in-development invocation that would no-op everything.
// -----------------------------------------------------------------------------
async function defaultDispatchImplNotProvided(): Promise<DispatchResult> {
  throw new Error(
    "habit-checkin: dispatchImpl is required (no default dispatcher wired yet)",
  );
}
