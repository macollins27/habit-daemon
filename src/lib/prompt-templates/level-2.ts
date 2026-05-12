// Task 25: L2 habit-checkin template — the curious check-in.
//
// L2 is the second escalation step. The voice is curious-not-loaded:
// "noticed no row yet — what's going on?" — brief, friendly, NOT accusatory,
// and crucially STILL no WHY content. The WHY wells (stakes, body data,
// patterns) fire at L3 and L4; L1 and L2 stay in the warm-friend register.
//
// Design § 3 captures the canonical example:
//
//   "L2 (9:35): Curious check-in, no why yet. 'No row yet — what's going on?'"
//
// The output schema mirrors L1's (one message_text + one next_check_in_iso).
// Phase A keeps the schema duplicated rather than extracted to a shared
// module: the level templates each own a small, complete unit, and the
// duplication cost is two lines of Zod. If a third level adopts the same
// schema verbatim, the refactor is trivial.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 25
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (escalation voice)
//   - src/lib/prompt-templates/level-1.ts (mirrored shape)

import { z } from "zod";
import type { LevelTemplate } from "../prompt-builder.js";

const L2_OUTPUT_SCHEMA = z.object({
  message_text: z
    .string()
    .min(1)
    .describe("The plain-English curious check-in to send to the user."),
  next_check_in_iso: z
    .string()
    .describe(
      "ISO 8601 timestamp the model suggests as the next check-in. The " +
        "orchestrator computes the actual escalation time per habit and " +
        "ignores this field in Phase A; it is still required so the model " +
        "thinks explicitly about cadence.",
    ),
});

function l2OutputSchemaString(): string {
  const json = z.toJSONSchema(L2_OUTPUT_SCHEMA) as Record<string, unknown>;
  delete json["$schema"];
  return JSON.stringify(json);
}

const L2_VOICE_RULES = `Voice rules for L2 (curious check-in, no why yet):

- Curious tone — NOT loaded, NOT accusatory, NOT moralizing. Think a friend
  who noticed you haven't done the thing yet and is genuinely asking what's
  up, not a coach reminding you of stakes.
- Brief: ONE sentence. Stop there.
- NO why content. Do NOT mention stakes, body data, sleep numbers, HRV, or
  pattern observations. L2 is still the warm-friend register — the WHY
  wells fire only at L3 and L4.
- Acknowledge the user has not yet completed the habit without judgment.
- Reference the habit naturally by what it is (e.g. "row", "lifts",
  "wind-down") rather than by the database id.

Output: a JSON object with two fields:
  - message_text: the plain-English curious prompt (one sentence).
  - next_check_in_iso: your suggested next check-in time as an ISO 8601 string.

Example for morning-row: "Hey — no row yet. What's going on?"
Example for wind-down: "Still up — what's going on?"`;

export const LEVEL_2_TEMPLATE: LevelTemplate = {
  levelName: "L2",
  voiceRules: L2_VOICE_RULES,
  outputSchema: l2OutputSchemaString(),
};
