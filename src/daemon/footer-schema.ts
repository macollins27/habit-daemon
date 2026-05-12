// Zod schema for the structured output every dispatched subagent emits.
// Passed to `claude -p --json-schema "<schema>"` so the runtime constrains
// generation token-by-token (per Anthropic's structured-outputs constrained
// decoding). The orchestrator then parses the JSON envelope's
// .structured_output field against this same Zod schema.
//
// References:
//   - https://code.claude.com/docs/en/agent-sdk/structured-outputs

import { z } from "zod";

export const FooterSchema = z
  .object({
    artifact_path: z
      .string()
      .nullable()
      .describe(
        "Absolute path to the verdict / report file the dispatch produced, or null if no artifact.",
      ),
    write_set: z
      .array(z.string())
      .default([])
      .describe(
        "Absolute paths the subagent modified during this dispatch. Empty array if read-only.",
      ),
    findings_status: z
      .enum(["CLEAN", "FINDINGS", "FAILED", "UNKNOWN"])
      .describe(
        "The dispatch's verdict on its own work. CLEAN = no findings; FINDINGS = found issues " +
          "to surface; FAILED = the dispatch could not complete; UNKNOWN = inconclusive.",
      ),
    root_cause: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Required when write_set is non-empty: one-line description of the root cause that " +
          "motivated the changes. The schema rejects empty root_cause when write_set has entries.",
      ),
    evidence: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Required when write_set is non-empty: one-line citation of file:line that supports " +
          "root_cause. The schema rejects empty evidence when write_set has entries.",
      ),
    confidence: z.enum(["low", "medium", "high"]).describe("Self-graded confidence in the work."),
    scope_risk: z
      .enum(["narrow", "moderate", "wide"])
      .describe("Self-graded scope risk: how much surface area was touched."),
    reversibility: z
      .enum(["clean", "migration-needed", "irreversible"])
      .describe("Self-graded reversibility of the changes."),
    tested: z
      .string()
      .optional()
      .describe("What was verified, by which test file. Empty if no tests run."),
    not_tested: z
      .string()
      .optional()
      .describe("Known gaps in test coverage with reasons. Empty if no known gaps."),
  })
  .describe("structured-output footer v1");

export type Footer = z.infer<typeof FooterSchema>;

export interface CrossFieldOk {
  readonly ok: true;
}
export interface CrossFieldFailure {
  readonly ok: false;
  readonly reason: string;
}
export type CrossFieldResult = CrossFieldOk | CrossFieldFailure;

/**
 * Cross-field validation that JSON Schema cannot natively express:
 * root_cause + evidence are REQUIRED when write_set is non-empty.
 * Per design v2 §4 step 6.
 */
export function validateFooterCrossFields(footer: Footer): CrossFieldResult {
  if (footer.write_set.length === 0) return { ok: true };
  if (!footer.root_cause || footer.root_cause.trim().length === 0) {
    return { ok: false, reason: "root_cause required when write_set is non-empty" };
  }
  if (!footer.evidence || footer.evidence.trim().length === 0) {
    return { ok: false, reason: "evidence required when write_set is non-empty" };
  }
  return { ok: true };
}

/**
 * Render the schema as a JSON-Schema string suitable for passing to
 * `claude -p --json-schema '<json>'`. Uses zod's built-in toJSONSchema (z/v4).
 *
 * The `$schema` field at the root is STRIPPED. Anthropic's tool-input schema
 * validator silently rejects any schema containing it — the StructuredOutput
 * tool then never registers, the model has no way to call it, and the
 * dispatch fails footer verification with no error in the envelope. Cost of
 * finding this: 5 failed dispatches (~$5) on the people domain. Reproducer:
 *   $ claude -p ... --json-schema '{"$schema":"...",...}'
 *     → silent failure, structured_output: None
 *   $ claude -p ... --json-schema '{...}'  (no $schema field)
 *     → structured_output populated correctly
 */
export function footerSchemaJson(): string {
  const schema = z.toJSONSchema(FooterSchema) as Record<string, unknown>;
  delete schema["$schema"];
  return JSON.stringify(schema);
}
