// Shared internals between `verify-proof.ts` (Tasks 33-37) and
// `reconcile-pending-runs.ts` (Task 1.2+).
//
// Both modules need to scan a list of cached Concept2 results for a
// session that satisfies the morning-row habit's min-minutes floor. The
// match logic is intentionally identical: Phase A morning-row is PM5-only
// and the design's qualifying criterion is `type === 'rower'` AND
// `duration_seconds >= min_minutes * 60`. Keeping a single source of truth
// here prevents the two callers from drifting (e.g. accepting different
// rower variants, or applying different min thresholds).
//
// The function is intentionally typed against the boundary-transformed
// `Concept2Result` shape (see `src/lib/concept2-adapter.ts:246-252` and
// commit e6a69c7). Do NOT loosen the parameter type to
// `Record<string, unknown>` — the cached payload is always
// post-boundary-transform, and loose typing would defeat the fix.

import type { Concept2Result } from "../lib/concept2-adapter.js";

/**
 * Pick the first rower session whose duration meets the min-minutes floor.
 *
 * Phase A: only `type === 'rower'` qualifies (the design's "morning row"
 * habit is PM5-specific). Future rower variants ('erg', 'skierg', etc.)
 * are intentionally excluded; revisit if the design adds cross-modal
 * proof.
 */
export function findQualifyingSession(
  results: readonly Concept2Result[],
  minMinutes: number,
): Concept2Result | undefined {
  const minSeconds = minMinutes * 60;
  return results.find(
    (r) => r.type === "rower" && r.duration_seconds >= minSeconds,
  );
}
