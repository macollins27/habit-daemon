/**
 * Unit tests for `computeStats`. The function is pure — it takes a
 * read-only array of `{fire_date, status}` and returns the four headline
 * stats the chat / web UI surfaces (completion rate, current streak,
 * longest streak, total runs).
 *
 * Streak definitions:
 *   - current_streak: count of consecutive `completed` runs at the END
 *     of the (chronologically sorted) sequence. Any non-completed status
 *     terminates it — including `pending` and `unresolved`. The streak
 *     therefore reflects "last unbroken stretch of completions", not
 *     "last completions ignoring open runs".
 *   - longest_streak: the longest such stretch anywhere in the sequence.
 *     A stretch ends on any non-completed status.
 *
 * Sort key: `computeStats` sorts a copy of its input by `fire_date`
 * ascending so callers can pass rows in any order and still get the
 * same answer.
 */
import { describe, it, expect } from "vitest";
import { computeStats } from "../../src/api/stats.js";

describe("computeStats", () => {
  it("returns zeros for an empty array", () => {
    expect(computeStats([])).toEqual({
      completion_rate: 0,
      current_streak: 0,
      longest_streak: 0,
      total_runs: 0,
    });
  });

  it("counts all-completed runs as completion_rate=1 and streaks=total", () => {
    const stats = computeStats([
      { fire_date: "2026-05-01", status: "completed" },
      { fire_date: "2026-05-02", status: "completed" },
      { fire_date: "2026-05-03", status: "completed" },
    ]);
    expect(stats).toEqual({
      completion_rate: 1,
      current_streak: 3,
      longest_streak: 3,
      total_runs: 3,
    });
  });

  it("counts all-missed runs as completion_rate=0 and streaks=0", () => {
    const stats = computeStats([
      { fire_date: "2026-05-01", status: "missed" },
      { fire_date: "2026-05-02", status: "missed" },
    ]);
    expect(stats).toEqual({
      completion_rate: 0,
      current_streak: 0,
      longest_streak: 0,
      total_runs: 2,
    });
  });

  it("handles alternating completed/missed correctly", () => {
    const stats = computeStats([
      { fire_date: "2026-05-01", status: "completed" },
      { fire_date: "2026-05-02", status: "missed" },
      { fire_date: "2026-05-03", status: "completed" },
      { fire_date: "2026-05-04", status: "missed" },
    ]);
    expect(stats.completion_rate).toBe(0.5);
    expect(stats.longest_streak).toBe(1);
    // Most recent is missed → current streak resets to 0.
    expect(stats.current_streak).toBe(0);
    expect(stats.total_runs).toBe(4);
  });

  it("non-completed non-missed (pending / unresolved) breaks the streak", () => {
    // pending should not count toward streak.
    const stats = computeStats([
      { fire_date: "2026-05-01", status: "completed" },
      { fire_date: "2026-05-02", status: "completed" },
      { fire_date: "2026-05-03", status: "pending" },
      { fire_date: "2026-05-04", status: "completed" },
    ]);
    expect(stats.current_streak).toBe(1);
    expect(stats.longest_streak).toBe(2);
    expect(stats.total_runs).toBe(4);
    // completion_rate counts completed only (3 of 4 = 0.75).
    expect(stats.completion_rate).toBe(0.75);
  });

  it("captures a current streak at the end of the sequence", () => {
    const stats = computeStats([
      { fire_date: "2026-05-01", status: "missed" },
      { fire_date: "2026-05-02", status: "completed" },
      { fire_date: "2026-05-03", status: "completed" },
      { fire_date: "2026-05-04", status: "completed" },
    ]);
    expect(stats.current_streak).toBe(3);
    expect(stats.longest_streak).toBe(3);
  });

  it("captures a longest streak in the middle of the sequence", () => {
    const stats = computeStats([
      { fire_date: "2026-05-01", status: "completed" },
      { fire_date: "2026-05-02", status: "completed" },
      { fire_date: "2026-05-03", status: "completed" },
      { fire_date: "2026-05-04", status: "completed" },
      { fire_date: "2026-05-05", status: "missed" },
      { fire_date: "2026-05-06", status: "completed" },
    ]);
    expect(stats.longest_streak).toBe(4);
    expect(stats.current_streak).toBe(1);
  });

  it("sorts input by fire_date ascending before computing", () => {
    // Pass rows out of order — the result should match the sorted order.
    const stats = computeStats([
      { fire_date: "2026-05-03", status: "completed" },
      { fire_date: "2026-05-01", status: "missed" },
      { fire_date: "2026-05-02", status: "completed" },
    ]);
    // Sorted: missed, completed, completed → current_streak=2, longest=2.
    expect(stats.current_streak).toBe(2);
    expect(stats.longest_streak).toBe(2);
  });
});
