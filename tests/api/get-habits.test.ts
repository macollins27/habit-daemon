/**
 * GET /api/habits — list endpoint.
 *
 * Public-shape contract: every row in the response uses the API field
 * names from HABIT_FIELD_TO_COLUMN (`display_name`, `cadence`,
 * `proof_config`, `why_stakes`) and never the raw DB column names
 * (`name`, `cron_expr`, `proof_config_json`, `why_stakes_json`). The
 * tests below enforce this directly by asserting BOTH the presence of
 * the API names AND the absence of the DB-column names — so a future
 * change that "passes through the row object" will fail loudly here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { archiveHabit } from "../../src/orchestrate/archive-habit.js";
import { setupHabitDb, seedHabit, type HabitDbHandle } from "./_helpers.js";

let handle: HabitDbHandle;

beforeEach(async () => {
  handle = await setupHabitDb();
});

afterEach(() => {
  handle.cleanup();
});

describe("GET /api/habits", () => {
  it("returns { habits: [...] } using the public API shape", async () => {
    seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { habits: ReadonlyArray<Record<string, unknown>> };
    expect(Array.isArray(body.habits)).toBe(true);
    expect(body.habits).toHaveLength(1);
    const h = body.habits[0]!;
    // Public API field names present:
    expect(h["display_name"]).toBe("Evening walk");
    expect(h["cadence"]).toBe("0 19 * * *");
    expect(h["proof_config"]).toEqual({ min_log_entries: 1 });
    expect(h["why_stakes"]).toEqual({ primary: "joints" });
    expect(h["channel_id"]).toBe("test-channel-walk");
    expect(h["proof_type"]).toBe("training_log_photo");
    // DB column names absent:
    expect(h).not.toHaveProperty("name");
    expect(h).not.toHaveProperty("cron_expr");
    expect(h).not.toHaveProperty("proof_config_json");
    expect(h).not.toHaveProperty("why_stakes_json");
    // Identity + metadata:
    expect(h["id"]).toBe("habit_evening-walk");
    expect(typeof h["created_at"]).toBe("number");
    expect(h["active"]).toBe(1);
    expect(h["archived_at"]).toBeNull();
  });

  it("excludes archived habits by default", async () => {
    seedHabit(handle, { slug: "evening-walk" });
    const archivedId = seedHabit(handle, {
      slug: "old-habit",
      channel_id: "test-channel-old",
    });
    archiveHabit({ sessionStore: handle.ledger.sessionStore, id: archivedId });

    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits");
    const body = (await res.json()) as { habits: ReadonlyArray<{ id: string }> };
    expect(body.habits).toHaveLength(1);
    expect(body.habits[0]!.id).toBe("habit_evening-walk");
  });

  it("includes archived habits when ?include_archived=1 is passed", async () => {
    seedHabit(handle, { slug: "evening-walk" });
    const archivedId = seedHabit(handle, {
      slug: "old-habit",
      channel_id: "test-channel-old",
    });
    archiveHabit({ sessionStore: handle.ledger.sessionStore, id: archivedId });

    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits?include_archived=1");
    const body = (await res.json()) as {
      habits: ReadonlyArray<{ id: string; archived_at: string | null }>;
    };
    expect(body.habits).toHaveLength(2);
    const archivedRow = body.habits.find((h) => h.id === archivedId);
    expect(archivedRow).toBeDefined();
    expect(typeof archivedRow!.archived_at).toBe("string");
  });

  it("joins today's run status (today_run is null when no run exists)", async () => {
    seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits");
    const body = (await res.json()) as {
      habits: ReadonlyArray<{ today_run: unknown }>;
    };
    expect(body.habits[0]!.today_run).toBeNull();
  });

  it("joins today's run status when a run exists for today", async () => {
    const habitId = seedHabit(handle, { slug: "evening-walk" });
    // Insert a habit_runs row dated today. fire_date stored as YYYY-MM-DD
    // per src/db/migrations/001_habits.sql.
    const today = new Date().toISOString().slice(0, 10);
    handle.ledger.sessionStore.db
      .prepare(
        `INSERT INTO habit_runs (
           id, habit_id, fire_date, fired_at, current_level, status
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("run_today_1", habitId, today, Date.now(), 3, "pending");

    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits");
    const body = (await res.json()) as {
      habits: ReadonlyArray<{
        today_run: { id: string; status: string; current_level: number } | null;
      }>;
    };
    expect(body.habits[0]!.today_run).toEqual({
      id: "run_today_1",
      status: "pending",
      current_level: 3,
    });
  });

  it("orders most recently created first", async () => {
    const first = seedHabit(handle, { slug: "first", channel_id: "ch1" });
    // Tiny sleep so created_at differs even on fast machines.
    await new Promise((r) => setTimeout(r, 5));
    const second = seedHabit(handle, { slug: "second", channel_id: "ch2" });
    await new Promise((r) => setTimeout(r, 5));
    const third = seedHabit(handle, { slug: "third", channel_id: "ch3" });

    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits");
    const body = (await res.json()) as { habits: ReadonlyArray<{ id: string }> };
    expect(body.habits.map((h) => h.id)).toEqual([third, second, first]);
  });
});
