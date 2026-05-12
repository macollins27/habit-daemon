// Task 28: L3 habit-checkin template — the WHY hammer (body_data_well branch).
//
// L3 is the first escalation step where WHY content is deployed. The selector
// (Task 26 — selectWell) picks one of three payloads:
//   pattern  — Task 29 will wire it; Phase A dormant until then.
//   body_data — THIS template, fires when the body's signal disagrees with
//               its 30-day baseline (prior_night bottom-20% OR trailing-week
//               trend > 30 min / > 10%).
//   stakes    — Task 27 (rotating primary/secondary/tertiary stake).
//
// The voice rules instruct the model to anchor the message in the specific
// anomalous signals the selector flagged. The body_data well exists because
// generic "you might be tired" prompts have no signal; deploying the actual
// data the user already accepts (Garmin sleep / HRV) does.
//
// Output schema mirrors L1/L2/L3-stakes ({message_text, next_check_in_iso}).
// The orchestrator continues to ignore `next_check_in_iso` in Phase A —
// design § 3 owns cadence via the per-habit escalation delta table — but the
// field is retained so the model thinks explicitly about cadence.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 28
//   - docs/plans/2026-05-12-habit-daemon-design.md § 2 (body_data_well schema)
//   - src/lib/why-well-selector.ts (BodyDataPayload)
//   - src/lib/prompt-templates/level-3-stakes.ts (mirrored shape)
//   - src/lib/anomaly-detector.ts (the detector that produced the payload)

import { z } from "zod";
import type { LevelTemplate } from "../prompt-builder.js";
import type { BodyDataPayload } from "../why-well-selector.js";

const L3_BODY_DATA_OUTPUT_SCHEMA = z.object({
  message_text: z
    .string()
    .min(1)
    .describe(
      "The plain-English L3 message that connects the anomalous body signal " +
        "to the habit mechanism. One or two sentences.",
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

function l3BodyDataOutputSchemaString(): string {
  const json = z.toJSONSchema(L3_BODY_DATA_OUTPUT_SCHEMA) as Record<
    string,
    unknown
  >;
  delete json["$schema"];
  return JSON.stringify(json);
}

function buildVoiceRules(payload: BodyDataPayload): string {
  const anomalousList =
    payload.anomalousSignals.length === 0
      ? "(none — selector bug; respond defensively)"
      : payload.anomalousSignals.join(", ");

  return `Voice rules for L3 (WHY hammer — body_data_well anomaly):

This is the third escalation. The habit hasn't happened yet. The user's
own body data — recorded by Garmin overnight or aggregated across the
trailing week — shows a measurable anomaly versus their 30-day baseline.
You are NOT moralizing. You are NOT lecturing. You are NOT delivering
generic motivational material. You are observing the data and connecting
it to the habit mechanism.

Anomalous signals flagged by the detector: ${anomalousList}

Habit-specific framing template (from why_stakes.body_data_well.framing_template):

  "${payload.framingTemplate}"

Rules:
- Reference the specific signal that's off. Examples of acceptable phrasing:
  "REM was 78 min last night, bottom 15% of your month" or
  "sleep onset has been ~10 min later this week than your usual".
- Connect the signal to the habit's mechanism. Rowing primes the
  parasympathetic system. Lifting reinforces recovery sleep. Wind-down
  hits the sleep latency directly. Name the actual mechanism, not a
  metaphor.
- Don't moralize. Don't lecture. Don't pep talk. Just observe the data
  and connect it.
- Plain English. No marketing register, no motivational-poster phrasing,
  no "you've got this" energy.
- Brief: ONE or TWO sentences. Stop there.

Output: a JSON object with two fields:
  - message_text: the plain-English L3 prompt (1-2 sentences).
  - next_check_in_iso: your suggested next check-in time as an ISO 8601 string.

Example shape (for inspiration, not copying):
  "REM was 72 min last night — bottom 15% of your month. The row primes
   parasympathetic recovery; today's the day it actually helps."`;
}

/**
 * Build the L3 habit-checkin template for the body_data_well branch.
 *
 * The template is parameterised by the chosen `BodyDataPayload` because
 * each dispatch carries a habit-specific framing template plus the list of
 * anomalous signals the detector flagged. Keeping the template a factory
 * function (instead of a constant) lets the verb wire those values straight
 * into the voice rules without a separate templating layer.
 */
export function buildL3BodyDataTemplate(
  payload: BodyDataPayload,
): LevelTemplate {
  return {
    levelName: "L3",
    voiceRules: buildVoiceRules(payload),
    outputSchema: l3BodyDataOutputSchemaString(),
  };
}
