/**
 * GET /api/habits/:id — fetch a single habit by id, regardless of archive
 * state. Unlike the list endpoint, this one does NOT filter archived
 * rows — callers that drill in by id usually want to see the row even
 * if it's archived (e.g. the unarchive UI).
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

describe("GET /api/habits/:id", () => {
  it("returns the habit in the public API shape", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toBe(id);
    expect(body["display_name"]).toBe("Evening walk");
    expect(body["cadence"]).toBe("0 19 * * *");
    expect(body["proof_config"]).toEqual({ min_log_entries: 1 });
    expect(body["why_stakes"]).toEqual({ primary: "joints" });
    // DB column names absent:
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("cron_expr");
    expect(body).not.toHaveProperty("proof_config_json");
    expect(body).not.toHaveProperty("why_stakes_json");
  });

  it("returns 404 for an unknown id", async () => {
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits/habit_does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("returns archived habits (no implicit filter)", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    archiveHabit({ sessionStore: handle.ledger.sessionStore, id });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived_at: string | null };
    expect(typeof body.archived_at).toBe("string");
  });
});
