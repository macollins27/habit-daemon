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
import {
  selectWell,
  type MissReason,
  type SensorSignal,
  type StakeName,
  type WellSelection,
} from "../lib/why-well-selector.js";

// -----------------------------------------------------------------------------
// Per-habit escalation cadence (design § 3).
//
// L1→L2 delta minutes by habit. The fromLevel passed to
// `getEscalationDeltaMinutes` is the level that is CURRENTLY firing — i.e.,
// to schedule L2 we ask for delta(habitId, 1). Encoded for L1..L4 here so
// later tasks (L2/L3/L4 templates) can reuse the same table. wind-down has
// no L4→L5 entry because design § 3 says L4 is its terminal level.
// -----------------------------------------------------------------------------

const ESCALATION_DELTA_MINUTES: Readonly<
  Record<string, Readonly<Record<number, number>>>
> = {
  "morning-row": { 1: 30, 2: 30, 3: 30, 4: 30 },
  "strength-mwf": { 1: 30, 2: 30, 3: 30, 4: 30 },
  "wind-down": { 1: 8, 2: 5, 3: 2 },
};

export function getEscalationDeltaMinutes(
  habitId: string,
  fromLevel: number,
): number {
  const habitMap = ESCALATION_DELTA_MINUTES[habitId];
  if (habitMap === undefined) {
    throw new Error(`Unknown habit id for escalation table: ${habitId}`);
  }
  const delta = habitMap[fromLevel];
  if (delta === undefined) {
    throw new Error(
      `No escalation delta defined for habit=${habitId} fromLevel=${fromLevel}`,
    );
  }
  return delta;
}

// -----------------------------------------------------------------------------
// Channel routing: habit.domain → ChannelName.
//
// All three Phase A active habits each post to a dedicated channel. The map
// is kept as a literal `Record<string, ChannelName>` so TypeScript flags
// missing entries if a future habit ships without a channel.
// -----------------------------------------------------------------------------

const DOMAIN_TO_CHANNEL: Readonly<Record<string, ChannelName>> = {
  row: "morning-row",
  strength: "strength",
  "wind-down": "wind-down",
};

function channelForDomain(domain: string): ChannelName {
  const name = DOMAIN_TO_CHANNEL[domain];
  if (name === undefined) {
    throw new Error(`No channel mapping for habit domain: ${domain}`);
  }
  return name;
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
  readonly channel: ChannelName;
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
    default:
      throw new Error(
        `habit-checkin currentLevel=${currentLevel} is not supported yet (L1-L4 wired)`,
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
              proof_rejection_callout_due
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
  const recentEvents = loadRecentEventsForHabit(sessionStore, habit.id);

  const prompt = buildHabitCheckinPrompt({
    habit,
    run,
    currentLevel,
    recentEvents,
    levelTemplate,
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
  const channelName = channelForDomain(habit.domain);
  await postImpl({
    adapter,
    channel: channelName,
    content: messageText,
  });

  // ---------------------------------------------------------------------------
  // 7. Persist atomic state changes.
  //
  //    Compute nextEscalationAt from the per-habit table — the model's
  //    suggested next_check_in_iso is ignored in Phase A (design § 3 owns
  //    cadence).
  // ---------------------------------------------------------------------------
  const deltaMinutes = getEscalationDeltaMinutes(habit.id, currentLevel);
  const nextEscalationAt = now + deltaMinutes * 60 * 1000;
  const newLevel = currentLevel + 1;

  const persist = db.transaction(() => {
    db.prepare(
      `UPDATE habit_runs
          SET current_level = ?, next_escalation_at = ?
        WHERE id = ?`,
    ).run(newLevel, nextEscalationAt, runId);

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
    // json_extract and rotate / dedup. L1/L2 omit these fields entirely —
    // aat-chain.jsonCanonicalize rejects `undefined` keys, so we use a
    // conditional spread (the same pattern Task 19's
    // vision-rejection-counter uses).
    const eventPayload: Record<string, unknown> = {
      habitId: habit.id,
      runId,
      level: currentLevel,
      messageText,
      calloutFired,
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
