/**
 * Write-side habit endpoints — POST, PATCH, DELETE, and POST .../unarchive.
 *
 * These tests exercise the HTTP boundary directly via `app.request()`,
 * asserting:
 *   1. Status codes match the orchestrator's failure modes (404 / 409 / 400)
 *      via exact error-message substring matching against the actual
 *      orchestrator throws in
 *      `src/orchestrate/{create,update,archive}-habit.ts`.
 *   2. Side effects are visible via subsequent reads (GET) — proving the
 *      endpoint is wired to the same SessionStore the read-side sees.
 *   3. Idempotency: DELETE/unarchive on already-in-the-target-state rows
 *      returns 204 without throwing (the orchestrators are silent no-ops).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { setupHabitDb, seedHabit, defaultHabitInput, type HabitDbHandle } from "./_helpers.js";

let handle: HabitDbHandle;

beforeEach(async () => {
  handle = await setupHabitDb();
});

afterEach(() => {
  handle.cleanup();
});

describe("POST /api/habits", () => {
  it("returns 201 + { id } and the habit becomes visible via GET", async () => {
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const input = defaultHabitInput({ slug: "morning-meditate" });
    const res = await app.request("/api/habits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("habit_morning-meditate");

    // Follow-up GET sees the new habit.
    const listRes = await app.request("/api/habits");
    const listBody = (await listRes.json()) as {
      habits: ReadonlyArray<{ id: string; display_name: string }>;
    };
    const created = listBody.habits.find((h) => h.id === "habit_morning-meditate");
    expect(created).toBeDefined();
    expect(created!.display_name).toBe("Evening walk");
  });

  it("returns 400 on malformed body (missing display_name)", async () => {
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const bad = { ...defaultHabitInput(), display_name: undefined };
    delete (bad as Record<string, unknown>).display_name;
    const res = await app.request("/api/habits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: unknown };
    expect(body).toHaveProperty("error");
  });

  it("returns 400 on invalid cron expression", async () => {
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const bad = defaultHabitInput({ slug: "broken-cron", cadence: "not-a-cron" });
    const res = await app.request("/api/habits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: unknown };
    expect(body).toHaveProperty("error");
  });

  it("returns 409 on duplicate slug", async () => {
    seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaultHabitInput({ slug: "evening-walk" })),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/slug already exists/);
  });
});

describe("PATCH /api/habits/:id", () => {
  it("returns 204 and the field shows in a follow-up GET", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: "Evening stroll" }),
    });
    expect(res.status).toBe(204);

    const getRes = await app.request(`/api/habits/${id}`);
    const body = (await getRes.json()) as { display_name: string };
    expect(body.display_name).toBe("Evening stroll");
  });

  it("returns 404 on unknown id", async () => {
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits/habit_does-not-exist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: "anything" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown habit id/);
  });

  it("returns 400 on empty body", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/patch is empty/);
  });

  it("returns 400 on invalid cron in patch", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cadence: "not-a-cron" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid cron/);
  });
});

describe("DELETE /api/habits/:id", () => {
  it("returns 204 and the habit is excluded by default GET", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request(`/api/habits/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const listRes = await app.request("/api/habits");
    const listBody = (await listRes.json()) as { habits: ReadonlyArray<{ id: string }> };
    expect(listBody.habits.find((h) => h.id === id)).toBeUndefined();

    // With include_archived, the row is visible and carries an archived_at.
    const archivedRes = await app.request("/api/habits?include_archived=1");
    const archivedBody = (await archivedRes.json()) as {
      habits: ReadonlyArray<{ id: string; archived_at: string | null }>;
    };
    const row = archivedBody.habits.find((h) => h.id === id);
    expect(row).toBeDefined();
    expect(typeof row!.archived_at).toBe("string");
  });

  it("is idempotent — second DELETE still returns 204", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const first = await app.request(`/api/habits/${id}`, { method: "DELETE" });
    expect(first.status).toBe(204);
    const second = await app.request(`/api/habits/${id}`, { method: "DELETE" });
    expect(second.status).toBe(204);
  });
});

describe("POST /api/habits/:id/unarchive", () => {
  it("returns 204 and the habit is again visible in default GET", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    await app.request(`/api/habits/${id}`, { method: "DELETE" });

    const res = await app.request(`/api/habits/${id}/unarchive`, { method: "POST" });
    expect(res.status).toBe(204);

    const listRes = await app.request("/api/habits");
    const listBody = (await listRes.json()) as {
      habits: ReadonlyArray<{ id: string; archived_at: string | null }>;
    };
    const row = listBody.habits.find((h) => h.id === id);
    expect(row).toBeDefined();
    expect(row!.archived_at).toBeNull();
  });

  it("is idempotent — second unarchive still returns 204", async () => {
    const id = seedHabit(handle, { slug: "evening-walk" });
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const first = await app.request(`/api/habits/${id}/unarchive`, { method: "POST" });
    expect(first.status).toBe(204);
    const second = await app.request(`/api/habits/${id}/unarchive`, { method: "POST" });
    expect(second.status).toBe(204);
  });
});
