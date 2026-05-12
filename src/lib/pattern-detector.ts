// Task 29: extracted L3 pattern_well detection.
//
// One pure function consumed by the WHY-well selector (Task 26) and by the
// L3 habit-checkin pattern verb path (Task 29). The pattern detector groups
// trailing miss_reasons by slug prefix (everything before the first `:` in
// `inferred_specifics`) and reports whether any group has met the trigger
// threshold within the lookback window.
//
// Phase A keeps the table sparse: in practice the detector returns
// `thresholdMet: false` and the selector falls through to body_data or
// stakes. Phase B turns on classification + slug minting, at which point
// the same code path lights up automatically.
//
// The function is I/O-free; the caller (the L3 verb, via `selectWell`)
// pre-loads `miss_reasons` rows for the trailing 30 days. The detector then
// re-filters to its own lookback window (default 28d, threshold 3) to keep
// its contract independent of the verb's DB scoping.
//
// Defensive behaviour:
//   - Empty or sparse input → `{groups: [], thresholdMet: false, winner: null}`.
//   - `inferred_specifics === null` rows are skipped (no slug to group by).
//   - Malformed slugs (no `:`) are tolerated — the entire string becomes the
//     prefix. No throw. Phase B classification will write well-formed slugs;
//     until then, defensive parsing keeps the detector dormant rather than
//     fatal.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 29
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (L3 pattern_well)
//   - src/lib/why-well-selector.ts (consumer)
//   - src/orchestrate/habit-checkin.ts (downstream consumer via the selector)

import type { MissReason } from "./why-well-selector.js";

// ------------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------------

export interface PatternGroup {
  readonly slugPrefix: string;
  readonly count: number;
  readonly exemplarSpecifics: string;
}

export interface PatternDetectionResult {
  /** Every prefix group inside the lookback window, regardless of count. */
  readonly groups: readonly PatternGroup[];
  readonly thresholdMet: boolean;
  /** Largest group (ties → first encountered) IF threshold met, else null. */
  readonly winner: PatternGroup | null;
}

export interface PatternDetectionOptions {
  readonly lookbackDays?: number;
  readonly threshold?: number;
}

// ------------------------------------------------------------------------
// Constants — must stay aligned with the design § 3 trigger contract.
// ------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 28;
const DEFAULT_THRESHOLD = 3;

// ------------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------------

/**
 * Group trailing miss_reasons by slug prefix and report whether any group
 * has met the trigger threshold within the lookback window.
 *
 * Pure function — no I/O. The caller passes already-loaded rows; the
 * detector handles filtering, grouping, and threshold evaluation.
 *
 * Phase A contract: when the table is empty or sparse, the detector returns
 * `{thresholdMet: false, winner: null}` cleanly without throwing. The L3
 * selector then falls through to body_data or stakes.
 */
export function detectPattern(
  missReasons: readonly MissReason[],
  now: number,
  options?: PatternDetectionOptions,
): PatternDetectionResult {
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const lookbackMs = lookbackDays * DAY_MS;
  const since = now - lookbackMs;

  // Filter to in-window rows with usable inferred_specifics.
  // Group encounter order is the iteration order over the input — callers
  // pass rows in created_at ASC, so the first occurrence's full slug becomes
  // the exemplar.
  const groups = new Map<
    string,
    { readonly slugPrefix: string; count: number; exemplarSpecifics: string }
  >();

  for (const mr of missReasons) {
    if (mr.created_at < since) continue;
    if (mr.inferred_specifics === null) continue;

    // Defensive: even if there's no colon, take the whole string as the
    // prefix. Empty string after a leading colon is treated as "no prefix"
    // and skipped — the row gave us nothing to group by.
    const prefix = mr.inferred_specifics.split(":")[0];
    if (prefix === undefined || prefix === "") continue;

    const existing = groups.get(prefix);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(prefix, {
        slugPrefix: prefix,
        count: 1,
        exemplarSpecifics: mr.inferred_specifics,
      });
    }
  }

  const groupList: readonly PatternGroup[] = Array.from(groups.values()).map(
    (g) => ({
      slugPrefix: g.slugPrefix,
      count: g.count,
      exemplarSpecifics: g.exemplarSpecifics,
    }),
  );

  // Find the largest group at or above the threshold. Iteration order
  // mirrors the Map's insertion order — ties resolve to the first
  // encountered group.
  let winner: PatternGroup | null = null;
  for (const g of groupList) {
    if (g.count < threshold) continue;
    if (winner === null || g.count > winner.count) {
      winner = g;
    }
  }

  return {
    groups: groupList,
    thresholdMet: winner !== null,
    winner,
  };
}
