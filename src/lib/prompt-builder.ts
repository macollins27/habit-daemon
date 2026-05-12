// Task 24: shared prompt-builder used by every habit-checkin level template.
//
// Pure string composer:
//   - Takes a HabitContext (parsed habit row + parsed proof_config + parsed
//     why_stakes JSON), a RunContext (subset of habit_runs columns the prompt
//     cares about), a list of recent SessionEventRow rows, and a LevelTemplate
//     (level-specific voice rules + output schema).
//   - Emits the system prompt that will be passed to `claude -p --json-schema`
//     by the dispatch substrate.
//
// The single behavioural switch is `RunContext.proof_rejection_callout_due`:
// when 1, a CALLOUT block is prepended to the prompt instructing the model
// to acknowledge the run's accumulated rejected-photo count using the
// habit's `proof_config.vision_subject` as the noun. Phase A § Task 24 —
// the same flag is later reset to 0 by the habit-checkin verb after a
// successful dispatch (so the callout fires exactly once per "third strike").
//
// The builder does NOT touch the database, dispatch claude, or post to
// Discord. It is deliberately a pure function so:
//   - Unit tests can exercise voice-rule composition and callout
//     interpolation without any I/O.
//   - L2-L5 templates can be authored in later tasks against the same
//     contract without reaching into Discord/Claude wiring.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 24
//   - src/lib/prompt-templates/level-1.ts (LEVEL_1_TEMPLATE)
//   - src/orchestrate/habit-checkin.ts (consumes the composed prompt)

import type { SessionEventRow } from "../daemon/session-store.js";

/**
 * Parsed shape of the `habits` row plus the two JSON-encoded blobs the
 * prompt-builder needs. The orchestration verb parses `proof_config_json`
 * and `why_stakes_json` once and passes the result here — the builder never
 * touches JSON.parse itself.
 */
export interface HabitContext {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly cron_expr: string;
  readonly proof_type: string;
  readonly proof_config: Record<string, unknown>;
  readonly why_stakes: Record<string, unknown>;
}

/**
 * The subset of `habit_runs` columns the prompt-builder reads. Phase A § Task
 * 24 — `proof_rejection_callout_due` drives the CALLOUT block, every other
 * field is contextual.
 */
export interface RunContext {
  readonly id: string;
  readonly fire_date: string;
  readonly current_level: number;
  readonly status: string;
  readonly fired_at: number;
  readonly proof_rejection_callout_due: number;
}

/**
 * Per-level customization injected into the shared prompt. L1 lives in
 * src/lib/prompt-templates/level-1.ts; L2-L5 land in later tasks against the
 * same shape so the builder doesn't need to know which level it's serving.
 */
export interface LevelTemplate {
  readonly levelName: string;
  readonly voiceRules: string;
  readonly outputSchema: string;
}

export interface PromptBuildOptions {
  readonly habit: HabitContext;
  readonly run: RunContext;
  readonly currentLevel: number;
  readonly recentEvents: readonly SessionEventRow[];
  readonly levelTemplate: LevelTemplate;
}

function formatFiredAt(epochMs: number): string {
  // Local time is the daemon's reference frame per ADR 0001 (cron expressions
  // are interpreted in local time). Returning `toLocaleString()` would
  // emit machine-locale variance across CI hosts, so we use a stable
  // YYYY-MM-DD HH:MM:SS local-time format derived field by field.
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function buildCalloutBlock(habit: HabitContext): string {
  // proof_config is `Record<string, unknown>` — narrow the vision_subject
  // before interpolation. If a habit's proof_config genuinely has no
  // vision_subject (Phase A only morning-row, strength-mwf, wind-down all
  // do, but wind-down's is technically absent), fall back to the proof_type
  // so the callout still reads sensibly.
  const subjectRaw = habit.proof_config["vision_subject"];
  const subject =
    typeof subjectRaw === "string" && subjectRaw.length > 0
      ? subjectRaw
      : habit.proof_type;

  return [
    "CALLOUT: The user has had 3+ photo proof attempts rejected this run.",
    `Call this out directly in your message: "That's three photos that aren't the ${subject}. What's going on?"`,
    "Compose this naturally into the level's tone.",
    `At L1 it stays warm-friend ("Hey — three photos that weren't the ${subject}, what's going on?");`,
    "at L4 it's direct.",
  ].join(" ");
}

function buildRecentEventsBlock(
  events: readonly SessionEventRow[],
): string {
  if (events.length === 0) {
    return "Recent events: (none)";
  }
  // Render each event as `eventType @ writtenIso :: eventJson`. The eventJson
  // is the raw canonical payload — keeping it verbatim avoids the builder
  // making editorial choices that obscure structured fields downstream
  // L-templates may want to surface.
  const lines = events.map((e) => {
    const type = e.eventType ?? "(legacy)";
    return `- ${type} @ ${e.writtenIso} :: ${e.eventJson}`;
  });
  return ["Recent events (most recent first):", ...lines].join("\n");
}

function buildHabitContextBlock(habit: HabitContext): string {
  return [
    "Habit context:",
    `  name: ${habit.name}`,
    `  id: ${habit.id}`,
    `  domain: ${habit.domain}`,
    `  cron_expr: ${habit.cron_expr}`,
    `  proof_type: ${habit.proof_type}`,
    `  proof_config: ${JSON.stringify(habit.proof_config)}`,
  ].join("\n");
}

function buildRunContextBlock(run: RunContext): string {
  return [
    "Run context:",
    `  run_id: ${run.id}`,
    `  fire_date: ${run.fire_date}`,
    `  current_level: ${run.current_level}`,
    `  status: ${run.status}`,
    `  fired_at (local): ${formatFiredAt(run.fired_at)}`,
  ].join("\n");
}

/**
 * Compose the habit-checkin system prompt.
 *
 * Block order (top to bottom):
 *   1. Header — names the level + habit so the model orients quickly.
 *   2. CALLOUT block — present iff `run.proof_rejection_callout_due === 1`.
 *   3. Habit context — name, domain, cron, proof_type, proof_config.
 *   4. Run context — fire_date, level, status, fired_at.
 *   5. Recent events — last N events for this habit (already filtered by
 *      the orchestration verb).
 *   6. Level voice rules — exactly the `LevelTemplate.voiceRules` string.
 *   7. Output schema — the JSON Schema the dispatch substrate enforces
 *      via `--json-schema`.
 */
export function buildHabitCheckinPrompt(opts: PromptBuildOptions): string {
  const { habit, run, levelTemplate, recentEvents } = opts;

  const sections: string[] = [];

  sections.push(
    `You are sending a ${levelTemplate.levelName} habit prompt for ${habit.name}.`,
  );

  if (run.proof_rejection_callout_due === 1) {
    sections.push(buildCalloutBlock(habit));
  }

  sections.push(buildHabitContextBlock(habit));
  sections.push(buildRunContextBlock(run));
  sections.push(buildRecentEventsBlock(recentEvents));
  sections.push(levelTemplate.voiceRules);
  sections.push(
    `Respond with JSON matching this schema: ${levelTemplate.outputSchema}`,
  );

  return sections.join("\n\n");
}
