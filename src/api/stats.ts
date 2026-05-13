/**
 * Pure stats math over a habit's run history.
 *
 * `computeStats` operates on a normalized projection of `habit_runs`
 * (`{fire_date, status}`) so it's trivially unit-testable without a DB.
 * The endpoint that consumes this (`GET /api/habits/:id/stats`) selects
 * the projection from SQL and forwards the rows here.
 *
 * Streak semantics:
 *   - A "completed" status extends the current streak.
 *   - Any other status — including `pending`, `unresolved`,
 *     `unresolved_no_data`, `missed`, `skipped`, `partial` — breaks
 *     it. This intentionally treats `pending` (still-open) as a
 *     streak terminator. The alternative (ignoring open runs) would
 *     let a user "preserve" their streak by stalling.
 *   - completion_rate = completed / total. Total includes every status.
 */

export interface HabitRunForStats {
  readonly fire_date: string; // YYYY-MM-DD
  readonly status: string;
}

export interface HabitStats {
  readonly completion_rate: number;
  readonly current_streak: number;
  readonly longest_streak: number;
  readonly total_runs: number;
}

export function computeStats(runs: ReadonlyArray<HabitRunForStats>): HabitStats {
  // Sort a copy (input is readonly). String compare on YYYY-MM-DD is
  // lexicographically identical to chronological order, which avoids
  // a Date round-trip.
  const sorted = [...runs].sort((a, b) => a.fire_date.localeCompare(b.fire_date));
  const completed = sorted.filter((r) => r.status === "completed").length;
  const completionRate = sorted.length === 0 ? 0 : completed / sorted.length;

  let currentStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.status === "completed") {
      currentStreak++;
    } else {
      break;
    }
  }

  let longestStreak = 0;
  let run = 0;
  for (const r of sorted) {
    if (r.status === "completed") {
      run++;
      if (run > longestStreak) {
        longestStreak = run;
      }
    } else {
      run = 0;
    }
  }

  return {
    completion_rate: completionRate,
    current_streak: currentStreak,
    longest_streak: longestStreak,
    total_runs: sorted.length,
  };
}
