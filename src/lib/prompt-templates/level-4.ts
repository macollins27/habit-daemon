// Task 30: L4 habit-checkin template — the direct callout.
//
// L4 is the fourth escalation step. The voice is direct-callout-only: name
// the lateness, name the silence, name the missed proof. CRUCIALLY there is
// NO new WHY content at L4 — the WHY wells (stakes, body data, patterns)
// fired at L3, and L4 must NOT introduce new motivational framing. L4 is
// the tonal-only step between the WHY deployment (L3) and the terminal
// missed state (L5).
//
// Design § 3 captures the canonical example:
//
//   "L4 (10:35): Direct callout. 'Max. 90 minutes past. What's actually
//   blocking you right now?'"
//
// The output schema mirrors L1/L2's (one message_text + one
// next_check_in_iso). Phase A keeps the schema duplicated per template
// rather than extracted to a shared module: each level template owns a
// small, complete unit, and the duplication cost is two lines of Zod.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 30
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (escalation voice)
//   - src/lib/prompt-templates/level-2.ts (mirrored shape)

import { z } from "zod";
import type { LevelTemplate } from "../prompt-builder.js";

const L4_OUTPUT_SCHEMA = z.object({
  message_text: z
    .string()
    .min(1)
    .describe("The plain-English direct callout to send to the user."),
  next_check_in_iso: z
    .string()
    .describe(
      "ISO 8601 timestamp the model suggests as the next check-in. The " +
        "orchestrator computes the actual escalation time per habit and " +
        "ignores this field in Phase A; it is still required so the model " +
        "thinks explicitly about cadence.",
    ),
});

function l4OutputSchemaString(): string {
  const json = z.toJSONSchema(L4_OUTPUT_SCHEMA) as Record<string, unknown>;
  delete json["$schema"];
  return JSON.stringify(json);
}

const L4_VOICE_RULES = `Voice rules for L4 (direct callout, no new WHY):

- Direct callout only — name the lateness, name the silence, name the
  missed proof. Tonal, not motivational.
- NO new WHY content. The WHY was deployed at L3. Do NOT repeat stakes, do
  NOT cite body data (sleep, HRV), do NOT name pattern observations, and
  do NOT introduce any new motivational framing. L4 stays in the tonal
  register; the WHY work is already done.
- Compute the elapsed time from \`run.fired_at\` (rendered in the run
  context above) versus the current moment. If exact minutes feel
  awkward, phrase loosely ("hours later", "well past"). If you cannot
  compute it, omit the elapsed-time phrase rather than guess.
- ONE or TWO sentences. Plain English. Stop there.
- Curious but firm. Not pleading. Not lecturing. Not sarcastic.
- Reference the habit naturally by what it is (e.g. "row", "lifts",
  "wind down") rather than by the database id.

Output: a JSON object with two fields:
  - message_text: the plain-English direct callout (1-2 sentences).
  - next_check_in_iso: your suggested next check-in time as an ISO 8601 string.

Example for morning-row: "Max. 90 minutes past. What's actually blocking you right now?"
Example for strength-mwf: "Max — still no lifts. What's in the way?"`;

export const LEVEL_4_TEMPLATE: LevelTemplate = {
  levelName: "L4",
  voiceRules: L4_VOICE_RULES,
  outputSchema: l4OutputSchemaString(),
};
