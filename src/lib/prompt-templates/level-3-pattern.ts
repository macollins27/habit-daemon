// Task 29: L3 habit-checkin template — the WHY hammer (pattern_well branch).
//
// L3 is the first escalation step where WHY content is deployed. The selector
// (Task 26 — selectWell) picks one of three payloads:
//   pattern  — THIS template, fires when the trailing-28-day miss_reasons
//              table has 3+ same-slug-prefix rows for this habit (and the
//              14-day per-habit pattern cooldown has elapsed).
//   body_data — Task 28 (Garmin anomaly).
//   stakes    — Task 27 (rotating primary/secondary/tertiary stake).
//
// The voice rules instruct the model to name the pattern factually — the
// trailing data shows the user has missed the habit for the same reason
// 3+ times in 28 days. This is a pattern, not a one-off. The pattern data
// is the actual content of the prompt; generic motivational prose is
// forbidden.
//
// Phase A: the miss_reasons table is sparse — the classification + slug
// minting that fills it lands in Phase B. Until then, the selector returns
// pattern only rarely (typically when synthetic seeds force it). The
// template still ships in Phase A so the wiring is complete when Phase B
// activates the data path.
//
// Output schema mirrors L1/L2/L3-stakes/L3-body-data ({message_text,
// next_check_in_iso}). The orchestrator continues to ignore
// `next_check_in_iso` in Phase A — design § 3 owns cadence via the per-habit
// escalation delta table — but the field is retained so the model thinks
// explicitly about cadence.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 29
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (L3 pattern_well)
//   - src/lib/why-well-selector.ts (PatternPayload)
//   - src/lib/pattern-detector.ts (the detector that produced the payload)
//   - src/lib/prompt-templates/level-3-stakes.ts (mirrored shape)

import { z } from "zod";
import type { LevelTemplate } from "../prompt-builder.js";
import type { PatternPayload } from "../why-well-selector.js";

const L3_PATTERN_OUTPUT_SCHEMA = z.object({
  message_text: z
    .string()
    .min(1)
    .describe(
      "The plain-English L3 message that names the pattern factually and " +
        "connects it to the habit mechanism. One or two sentences.",
    ),
  next_check_in_iso: z
    .string()
    .describe(
      "ISO 8601 timestamp the model suggests as the next check-in. The " +
        "orchestrator computes the actual escalation time per habit and " +
        "ignores this field in Phase A; it is still required so the model " +
        "thinks explicitly about cadence.",
    ),
});

function l3PatternOutputSchemaString(): string {
  const json = z.toJSONSchema(L3_PATTERN_OUTPUT_SCHEMA) as Record<
    string,
    unknown
  >;
  delete json["$schema"];
  return JSON.stringify(json);
}

function buildVoiceRules(payload: PatternPayload): string {
  return `Voice rules for L3 (WHY hammer — pattern_well repeat):

This is the third escalation. The habit hasn't happened yet. Across the
trailing 28 days, the user has missed THIS HABIT for the same reason
category ${payload.count} time(s). This is a pattern, not a one-off. Deploy
this pattern data — name it factually and connect it to the habit
mechanism. You are NOT moralizing. You are NOT lecturing. You are NOT
delivering generic motivational material. You are reflecting the data
back.

The pattern the detector flagged:
  - slug prefix:       ${payload.slugPrefix}
  - occurrence count:  ${payload.count}
  - exemplar:          ${payload.exemplarSpecifics}

Habit-specific framing template (from why_stakes.pattern_well.framing_template):

  "${payload.framingTemplate}"

Rules:
- Name the pattern factually. Examples of acceptable phrasing:
  "This is the Nth time in 28 days the row has missed for the same
   reason — we figure it out now or it becomes the pattern."
- Connect the pattern to the habit's mechanism. Don't catastrophize.
  Don't moralize. The data is the message.
- Plain English. No marketing register, no motivational-poster phrasing,
  no "you've got this" energy. Curious + grounded, not punitive.
- Brief: ONE or TWO sentences. Stop there.

Output: a JSON object with two fields:
  - message_text: the plain-English L3 prompt (1-2 sentences).
  - next_check_in_iso: your suggested next check-in time as an ISO 8601 string.

Example shape (for inspiration, not copying):
  "Third time in 28 days the row missed for the same reason. We figure
   out the actual block now, or it becomes the default."`;
}

/**
 * Build the L3 habit-checkin template for the pattern_well branch.
 *
 * The template is parameterised by the chosen `PatternPayload` because each
 * dispatch carries a habit-specific framing template plus the slug-prefix,
 * count, and exemplar the detector flagged. Keeping the template a factory
 * function (instead of a constant) lets the verb wire those values straight
 * into the voice rules without a separate templating layer.
 */
export function buildL3PatternTemplate(payload: PatternPayload): LevelTemplate {
  return {
    levelName: "L3",
    voiceRules: buildVoiceRules(payload),
    outputSchema: l3PatternOutputSchemaString(),
  };
}
