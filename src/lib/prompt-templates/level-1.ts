// Task 24: L1 habit-checkin template (voice rules + output schema).
//
// L1 is the warm-friend opener: brief, plain English, no WHY content
// (no stakes well, no body data, no patterns). The model produces a one or
// two sentence message and a suggested next_check_in_iso (the orchestrator
// computes the actual escalation time per-habit and ignores the model's
// suggestion in Phase A).
//
// Source: docs/plans/2026-05-12-habit-daemon-design.md § 3 — "Warm, brief,
// no why. 'Morning Max. Row time. Send the PM5 photo when done.'"
//
// The output schema is built from a Zod schema and rendered as a JSON Schema
// string with the `$schema` root field stripped — same regression-history
// caveat as src/daemon/footer-schema.ts:footerSchemaJson().
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 24
//   - src/lib/prompt-builder.ts (consumes LevelTemplate)
//   - src/daemon/footer-schema.ts ($schema strip rationale)

import { z } from "zod";
import type { LevelTemplate } from "../prompt-builder.js";

const L1_OUTPUT_SCHEMA = z.object({
  message_text: z
    .string()
    .min(1)
    .describe("The plain-English warm-friend prompt to send to the user."),
  next_check_in_iso: z
    .string()
    .describe(
      "ISO 8601 timestamp the model suggests as the next check-in. The " +
        "orchestrator computes the actual escalation time per habit and " +
        "ignores this field in Phase A; it is still required so the model " +
        "thinks explicitly about cadence.",
    ),
});

function l1OutputSchemaString(): string {
  const json = z.toJSONSchema(L1_OUTPUT_SCHEMA) as Record<string, unknown>;
  delete json["$schema"];
  return JSON.stringify(json);
}

const L1_VOICE_RULES = `Voice rules for L1 (warm-friend opener):

- Plain English. No marketing register, no motivational-poster phrasing.
- Warm-friend tone — think a close friend sending a one-line nudge, not a coach.
- Brief: ONE or TWO sentences. Stop there.
- NO why content. Do NOT mention stakes, body data, sleep numbers, HRV, or pattern
  observations. L1 is the friendly opener — the WHY wells fire only at L3 and L4.
- Reference the habit naturally by what it is (e.g. "Row time", "lifts", "wind down")
  rather than by the database id.
- One concrete next action when relevant (e.g. "Send the PM5 photo when done.").

Output: a JSON object with two fields:
  - message_text: the plain-English prompt string (1-2 sentences).
  - next_check_in_iso: your suggested next check-in time as an ISO 8601 string.

Example for morning-row: "Morning Max. Row time. Send the PM5 photo when done."`;

export const LEVEL_1_TEMPLATE: LevelTemplate = {
  levelName: "L1",
  voiceRules: L1_VOICE_RULES,
  outputSchema: l1OutputSchemaString(),
};
