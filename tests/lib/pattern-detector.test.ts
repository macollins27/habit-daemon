// Task 29: tests for the pattern-detector module — extracted L3 pattern_well
// helper used by `selectWell` and (when active) the L3 verb path.
//
// One pure function:
//
//   detectPattern(missReasons, now, options?)
//     - Filters to the trailing `lookbackDays` (default 28) window.
//     - Groups by the slug prefix (everything before the first `:` in
//       `inferred_specifics`).
//     - Returns `{groups, thresholdMet, winner}`:
//         - `groups`: every prefix group regardless of count, in encounter
//           order.
//         - `thresholdMet`: true iff some group's `count >= threshold`
//           (default 3).
//         - `winner`: the largest group (ties → first encountered) IF the
//           threshold is met, else null.
//     - Skips entries with `inferred_specifics === null`.
//     - Skips entries whose `inferred_specifics` has no usable prefix
//       (defensive: malformed slug shouldn't throw).
//
// Phase A: the table is empty or sparse, so the detector must return
// `thresholdMet: false` cleanly. Phase B activates the rest of the logic.
//
// Tests are intentionally pure (no DB).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 29
//   - src/lib/pattern-detector.ts (module under test)
//   - src/lib/why-well-selector.ts (consumer)

import { describe, it, expect } from "vitest";
import { detectPattern } from "../../src/lib/pattern-detector.js";
import type { MissReason } from "../../src/lib/why-well-selector.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-05-12T12:00:00Z");

function missReason(opts: {
  id?: string;
  slug: string | null;
  ageDays: number;
}): MissReason {
  return {
    id: opts.id ?? `mr-${opts.slug ?? "null"}-${opts.ageDays}`,
    habit_id: "strength-mwf",
    run_id: "run-old",
    miss_date: "2026-04-30",
    inferred_specifics: opts.slug,
    classification: null,
    created_at: NOW - opts.ageDays * DAY_MS,
  };
}

describe("detectPattern — dormant no-op cases", () => {
  it("returns thresholdMet=false, winner=null, groups=[] for empty miss_reasons", () => {
    const result = detectPattern([], NOW);
    expect(result.thresholdMet).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.groups).toEqual([]);
  });

  it("returns thresholdMet=false for a single entry", () => {
    const result = detectPattern(
      [missReason({ slug: "late-gaming-friend:brian", ageDays: 1 })],
      NOW,
    );
    expect(result.thresholdMet).toBe(false);
    expect(result.winner).toBeNull();
    // Single group still surfaces in groups[]
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.slugPrefix).toBe("late-gaming-friend");
    expect(result.groups[0]!.count).toBe(1);
  });

  it("returns thresholdMet=false for two same-slug entries (below threshold)", () => {
    const result = detectPattern(
      [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 5 }),
      ],
      NOW,
    );
    expect(result.thresholdMet).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.count).toBe(2);
  });
});

describe("detectPattern — threshold met", () => {
  it("returns thresholdMet=true and the correct winner for 3 same-slug entries", () => {
    const result = detectPattern(
      [
        missReason({ slug: "late-gaming-friend:brian", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:carl", ageDays: 4 }),
        missReason({ slug: "late-gaming-friend:dave", ageDays: 7 }),
      ],
      NOW,
    );
    expect(result.thresholdMet).toBe(true);
    expect(result.winner).not.toBeNull();
    expect(result.winner!.slugPrefix).toBe("late-gaming-friend");
    expect(result.winner!.count).toBe(3);
    // Exemplar = first occurrence's full inferred_specifics
    expect(result.winner!.exemplarSpecifics).toBe("late-gaming-friend:brian");
  });

  it("returns thresholdMet=false when 4 entries are split 2/2 across slugs", () => {
    const result = detectPattern(
      [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 2 }),
        missReason({ slug: "work-emergency:zoom", ageDays: 3 }),
        missReason({ slug: "work-emergency:call", ageDays: 4 }),
      ],
      NOW,
    );
    expect(result.thresholdMet).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.groups).toHaveLength(2);
  });

  it("picks the largest group when multiple prefixes hit threshold (3 + 4)", () => {
    const result = detectPattern(
      [
        missReason({ slug: "small:a", ageDays: 1 }),
        missReason({ slug: "small:b", ageDays: 2 }),
        missReason({ slug: "small:c", ageDays: 3 }),
        missReason({ slug: "big:a", ageDays: 4 }),
        missReason({ slug: "big:b", ageDays: 5 }),
        missReason({ slug: "big:c", ageDays: 6 }),
        missReason({ slug: "big:d", ageDays: 7 }),
      ],
      NOW,
    );
    expect(result.thresholdMet).toBe(true);
    expect(result.winner!.slugPrefix).toBe("big");
    expect(result.winner!.count).toBe(4);
  });
});

describe("detectPattern — lookback window", () => {
  it("excludes entries older than the 28-day default lookback", () => {
    const result = detectPattern(
      [
        // 2 inside window + 1 outside → only 2 in-window → threshold not met
        missReason({ slug: "late-gaming-friend:a", ageDays: 2 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 10 }),
        missReason({ slug: "late-gaming-friend:c", ageDays: 29 }),
      ],
      NOW,
    );
    expect(result.thresholdMet).toBe(false);
    expect(result.winner).toBeNull();
    // Only in-window entries are grouped
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.count).toBe(2);
  });

  it("counts 5 in-window even when 10 older same-slug entries are also present", () => {
    const inWindow = Array.from({ length: 5 }, (_, i) =>
      missReason({
        slug: `late-gaming-friend:n${i}`,
        ageDays: i + 1,
        id: `mr-recent-${i}`,
      }),
    );
    const tooOld = Array.from({ length: 10 }, (_, i) =>
      missReason({
        slug: `late-gaming-friend:old${i}`,
        ageDays: 30 + i,
        id: `mr-old-${i}`,
      }),
    );
    const result = detectPattern([...inWindow, ...tooOld], NOW);
    expect(result.thresholdMet).toBe(true);
    expect(result.winner!.count).toBe(5);
  });
});

describe("detectPattern — defensive parsing", () => {
  it("skips rows whose inferred_specifics is null", () => {
    const result = detectPattern(
      [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: null, ageDays: 2 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 3 }),
        missReason({ slug: null, ageDays: 4 }),
        missReason({ slug: "late-gaming-friend:c", ageDays: 5 }),
      ],
      NOW,
    );
    expect(result.thresholdMet).toBe(true);
    expect(result.winner!.count).toBe(3);
  });

  it("does not throw on malformed inferred_specifics (no colon)", () => {
    expect(() =>
      detectPattern(
        [
          missReason({ slug: "no-colon-slug", ageDays: 1 }),
          missReason({ slug: "another-no-colon", ageDays: 2 }),
        ],
        NOW,
      ),
    ).not.toThrow();
  });
});

describe("detectPattern — options", () => {
  it("honours a custom threshold (threshold=2 hits with 2 entries)", () => {
    const result = detectPattern(
      [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 4 }),
      ],
      NOW,
      { threshold: 2 },
    );
    expect(result.thresholdMet).toBe(true);
    expect(result.winner!.count).toBe(2);
  });

  it("honours a custom lookbackDays (lookbackDays=7 excludes 10-day-old entry)", () => {
    const result = detectPattern(
      [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 5 }),
        missReason({ slug: "late-gaming-friend:c", ageDays: 10 }),
      ],
      NOW,
      { lookbackDays: 7, threshold: 3 },
    );
    expect(result.thresholdMet).toBe(false);
    expect(result.winner).toBeNull();
  });
});
