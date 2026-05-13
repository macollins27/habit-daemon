/**
 * GET /api/habits/:id/runs — paginated history of a habit's runs.
 *
 * Response shape: { runs: [...] } with `miss_reason` left-joined from
 * `miss_reasons` (latest one when multiple — picked by max(created_at)).
 *
 * Query params:
 *   - `since=<YYYY-MM-DD>` filters to runs with fire_date >= since.
 *   - `limit=<N>` (default 30, max 365). Out-of-range values clamp.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { setupHabitDb, seedHabit, type HabitDbHandle } from "./_helpers.js";

let handle: HabitDbHandle;

beforeEach(async () => {
  handle = await setupHabitDb();
});

afterEach(() => {
  handle.cleanup();
});

interface SeededRun {
  readonly id: string;
  readonly fire_date: string;
  readonly status: "pending" | "completed" | "missed";
  readonly current_level: number;
}

function insertRun(habitId: string, run: SeededRun, nextEscalationAt: number | null = null): void {
  handle.ledger.sessionStore.db
    .prepare(
      `INSERT INTO habit_runs (
         id, habit_id, fire_date, fired_at, current_level,
         next_escalation_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(run.id, habitId, run.fire_date, Date.now(), run.current_level, nextEscalationAt, run.status);
}

function insertMissReason(
  habitId: string,
  runId: string,
  fireDate: string,
  classification: string,
  createdAt: number,
): void {
  handle.ledger.sessionStore.db
    .prepare(
      `INSERT INTO miss_reasons (
         id, habit_id, run_id, miss_date,
         user_response_text, classification,
         inferred_specifics, key_entities_json,
         classification_confidence, gap_metadata_json, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?)`,
    )
    .run(`miss_${runId}_${createdAt}`, habitId, runId, fireDate, classification, createdAt);
}

describe("GET /api/habits/:id/runs", () => {
  it("returns runs in the documented shape, most recent fire_date first", async () => {
    const habitId = seedHabit(handle, { slug: "evening-walk" });
    insertRun(habitId, {
      id: "run_a",
      fire_date: "2026-05-10",
      status: "pending",
      current_level: 1,
    }, 1234567890);
    insertRun(habitId, {
      id: "run_b",
      fire_date: "2026-05-11",
      status: "completed",
      current_level: 4,
    });
    insertRun(habitId, {
      id: "run_c",
      fire_date: "2026-05-12",
      status: "missed",
      current_level: 5,
    });
    insertMissReason(habitId, "run_c", "2026-05-12", "work-late", Date.now());

    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${habitId}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: ReadonlyArray<{
        id: string;
        fire_date: string;
        status: string;
        current_level: number;
        next_escalation_at: number | null;
        miss_reason: string | null;
      }>;
    };
    expect(body.runs.map((r) => r.id)).toEqual(["run_c", "run_b", "run_a"]);
    const cRow = body.runs[0]!;
    expect(cRow.fire_date).toBe("2026-05-12");
    expect(cRow.status).toBe("missed");
    expect(cRow.current_level).toBe(5);
    expect(cRow.next_escalation_at).toBeNull();
    expect(cRow.miss_reason).toBe("work-late");
    const aRow = body.runs[2]!;
    expect(aRow.next_escalation_at).toBe(1234567890);
    expect(aRow.miss_reason).toBeNull();
  });

  it("filters with ?since=<ISO date>", async () => {
    const habitId = seedHabit(handle, { slug: "evening-walk" });
    insertRun(habitId, { id: "run_old", fire_date: "2026-04-30", status: "completed", current_level: 1 });
    insertRun(habitId, { id: "run_new", fire_date: "2026-05-10", status: "pending", current_level: 2 });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${habitId}/runs?since=2026-05-01`);
    const body = (await res.json()) as { runs: ReadonlyArray<{ id: string }> };
    expect(body.runs.map((r) => r.id)).toEqual(["run_new"]);
  });

  it("honors ?limit and clamps to a maximum of 365", async () => {
    const habitId = seedHabit(handle, { slug: "evening-walk" });
    for (let i = 0; i < 50; i++) {
      insertRun(habitId, {
        id: `run_${i}`,
        // Generate distinct sortable dates: 2024-..-..
        fire_date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
        status: "completed",
        current_level: 1,
      });
    }
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    // Custom limit smaller than total inserted.
    const small = await app.request(`/api/habits/${habitId}/runs?limit=10`);
    const smallBody = (await small.json()) as { runs: ReadonlyArray<{ id: string }> };
    expect(smallBody.runs).toHaveLength(10);
    // Out-of-range high — clamps to 365 (we have only 50 rows).
    const big = await app.request(`/api/habits/${habitId}/runs?limit=99999`);
    const bigBody = (await big.json()) as { runs: ReadonlyArray<{ id: string }> };
    expect(bigBody.runs.length).toBeLessThanOrEqual(365);
    expect(bigBody.runs).toHaveLength(50);
  });

  it("defaults limit to 30 when omitted", async () => {
    const habitId = seedHabit(handle, { slug: "evening-walk" });
    for (let i = 0; i < 40; i++) {
      insertRun(habitId, {
        id: `run_${i}`,
        fire_date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
        status: "completed",
        current_level: 1,
      });
    }
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${habitId}/runs`);
    const body = (await res.json()) as { runs: ReadonlyArray<{ id: string }> };
    expect(body.runs).toHaveLength(30);
  });
});
