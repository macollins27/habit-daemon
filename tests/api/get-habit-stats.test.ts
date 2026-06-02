/**
 * GET /api/habits/:id/stats — integration test.
 *
 * The endpoint SELECTs every run for the habit (no LIMIT) and passes the
 * `{fire_date, status}` projection to `computeStats`. This test asserts
 * that the JSON body matches what `computeStats` returns when run against
 * the same seed data — proving the endpoint doesn't apply any silent
 * filter or drop columns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { computeStats } from "../../src/api/stats.js";
import { setupHabitDb, seedHabit, type HabitDbHandle } from "./_helpers.js";

let handle: HabitDbHandle;

beforeEach(async () => {
  handle = await setupHabitDb();
});

afterEach(() => {
  handle.cleanup();
});

function insertRun(habitId: string, fireDate: string, status: string, runId?: string): void {
  handle.ledger.sessionStore.db
    .prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level, status
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId ?? `run_${fireDate}`, habitId, fireDate, Date.now(), 1, status);
}

describe("GET /api/habits/:id/stats", () => {
  it("returns zeros for a habit with no runs", async () => {
    const habitId = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${habitId}/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body).toEqual({
      completion_rate: 0,
      current_streak: 0,
      longest_streak: 0,
      total_runs: 0,
    });
  });

  it("matches computeStats() against the seeded run history", async () => {
    const habitId = seedHabit(handle, { slug: "evening-walk" });
    const runs: ReadonlyArray<{ fire_date: string; status: string }> = [
      { fire_date: "2026-05-01", status: "completed" },
      { fire_date: "2026-05-02", status: "completed" },
      { fire_date: "2026-05-03", status: "missed" },
      { fire_date: "2026-05-04", status: "completed" },
      { fire_date: "2026-05-05", status: "completed" },
      { fire_date: "2026-05-06", status: "completed" },
    ];
    for (const r of runs) insertRun(habitId, r.fire_date, r.status);
    const expected = computeStats(runs);

    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${habitId}/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body).toEqual(expected);
    expect(body["current_streak"]).toBe(3);
    expect(body["longest_streak"]).toBe(3);
  });

  it("returns 404 for unknown habit id", async () => {
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits/habit_missing/stats");
    expect(res.status).toBe(404);
  });
});
