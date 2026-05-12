// Task 27: L3 habit-checkin template — the WHY hammer (stakes_well branch).
//
// L3 is the first escalation step where WHY content is deployed. The selector
// (Task 26 — selectWell) picks one of three payloads:
//   pattern  — Phase B (Task 29 will wire it; Phase A is dormant)
//   body_data — Task 28 will wire it
//   stakes    — THIS template, the rotating primary/secondary/tertiary stake
//
// The voice rules instruct the model to compose the named stake into a short,
// grounded message rather than generic motivational prose. The stake string
// itself is interpolated into the prompt verbatim — the model voices it, but
// the underlying language is the user's own pre-committed context.
//
// The output schema mirrors L1/L2 ({message_text, next_check_in_iso}). The
// orchestrator continues to ignore `next_check_in_iso` in Phase A (design § 3
// owns cadence via the per-habit escalation delta table), but the field is
// retained so the model thinks explicitly about cadence.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 27
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (L3 stakes rotation)
//   - src/lib/why-well-selector.ts (StakesPayload)
//   - src/lib/prompt-templates/level-1.ts (mirrored output-schema shape)

import { z } from "zod";
import type { LevelTemplate } from "../prompt-builder.js";
import type { StakesPayload } from "../why-well-selector.js";

const L3_STAKES_OUTPUT_SCHEMA = z.object({
  message_text: z
    .string()
    .min(1)
    .describe(
      "The plain-English L3 message that voices the named stake into a one " +
        "or two sentence prompt. Not a recitation of the stake text.",
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

function l3StakesOutputSchemaString(): string {
  const json = z.toJSONSchema(L3_STAKES_OUTPUT_SCHEMA) as Record<
    string,
    unknown
  >;
  delete json["$schema"];
  return JSON.stringify(json);
}

function buildVoiceRules(payload: StakesPayload): string {
  return `Voice rules for L3 (WHY hammer — stakes_well rotation):

This is the third escalation. The habit hasn't happened yet. You are NOT
continuing to ask politely. You are NOT moralizing. You are NOT lecturing
about the importance of habits in general. You are deploying a SPECIFIC,
named stake that the user pre-committed to in their context.

The stake to deploy in THIS message:

  "${payload.text}"

This is the ${payload.stake} stake (rotation: primary / secondary / tertiary,
7-day dedup — the orchestrator picks which stake to deploy and rotates).

Rules:
- Compose the stake naturally into a one-or-two-sentence message. Don't
  quote the stake verbatim like a recitation; voice it.
- The mechanism, not the metaphor. Name the actual consequence the stake
  describes.
- Plain English. No marketing register. No "let's do this together" energy.
- Curious + grounded, not punitive. No pep talk, no motivational-poster
  phrasing, no generic "you've got this" content.
- Brief: ONE or TWO sentences. Stop there.

Output: a JSON object with two fields:
  - message_text: the plain-English L3 prompt (1-2 sentences).
  - next_check_in_iso: your suggested next check-in time as an ISO 8601 string.

Example shape (for inspiration, not copying):
  "Max. 12 months post-fracture. The row IS the recovery — skipping it
   stalls it. Where are we at?"
  (The stake here is the primary fracture-recovery stake.)`;
}

/**
 * Build the L3 habit-checkin template for the stakes_well branch.
 *
 * The template is parameterised by the chosen `StakesPayload` because each
 * dispatch may target a different stake (the rotation primary →
 * secondary → tertiary cycles every 7 days). Keeping the template a factory
 * function instead of a constant lets the verb wire the chosen stake text
 * straight into the voice rules without a separate templating layer.
 */
export function buildL3StakesTemplate(payload: StakesPayload): LevelTemplate {
  return {
    levelName: "L3",
    voiceRules: buildVoiceRules(payload),
    outputSchema: l3StakesOutputSchemaString(),
  };
}
