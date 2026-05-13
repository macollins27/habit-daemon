/**
 * Parsers for the `habits.proof_config_json` column, shared between the
 * reconciler (`reconcile-pending-runs.ts`) and the eligibility gate
 * (`check-provable.ts`).
 *
 * Both parsers fail closed: missing or non-string/non-number fields throw
 * with the habit id included so the daemon's structured error logs (and
 * the eventual operator-facing surface) can identify the offending row.
 */

export interface MorningRowProofConfig {
  readonly min_minutes: number;
}

export interface WindDownProofConfig {
  readonly stage_b_threshold: string;
}

export function parseMorningRowConfig(
  json: string,
  habitId: string,
): MorningRowProofConfig {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const minMinutes = parsed.min_minutes;
  if (typeof minMinutes !== "number") {
    throw new Error(
      `habit ${habitId} proof_config_json missing numeric min_minutes`,
    );
  }
  return { min_minutes: minMinutes };
}

export function parseWindDownConfig(
  json: string,
  habitId: string,
): WindDownProofConfig {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const threshold = parsed.stage_b_threshold;
  if (typeof threshold !== "string") {
    throw new Error(
      `habit ${habitId} proof_config_json missing stage_b_threshold string`,
    );
  }
  return { stage_b_threshold: threshold };
}
