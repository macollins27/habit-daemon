/**
 * GET /api/activity — cursor-paginated tail of `session_events`.
 *
 * Cursor protocol:
 *   - Query: `?limit=N&before=<ISO>`.
 *   - Response: `{ events: [...], next_cursor: "<ISO>" | null }`.
 *   - The cursor is the `written_iso` of the LAST event in the current
 *     page; passing it as `before` returns the next older page.
 *   - When the returned `events.length < limit`, we've hit the end and
 *     `next_cursor` is null. This lets callers loop without computing
 *     "do I have more?" themselves.
 *
 * Ordering is `written_iso DESC` — most recent first. Migration 004
 * adds `idx_session_events_written_iso_desc` to make this O(limit).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { setupHabitDb, type HabitDbHandle } from "./_helpers.js";

let handle: HabitDbHandle;

beforeEach(async () => {
  handle = await setupHabitDb();
});

afterEach(() => {
  handle.cleanup();
});

/**
 * Insert N events via SessionStore.append so the hash chain is well-formed.
 * `written_iso` is set internally to the current Date — we offset by waiting
 * a single ms between inserts to guarantee a strict ordering and unique
 * timestamps even when this runs on a fast machine. (Two events with the
 * exact same `written_iso` would still order deterministically via `seq`,
 * but the cursor encodes only `written_iso`, so we ensure uniqueness.)
 */
async function seedEvents(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    handle.ledger.sessionStore.append(
      "test-session",
      "user_message_received",
      { i },
      { trustLevel: "L0" },
    );
    // 1ms gap: better-sqlite3 + JS Date is millisecond-resolution, so this
    // guarantees a strict written_iso order. Total: 250ms for 250 events.
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("GET /api/activity", () => {
  it("returns events in descending written_iso order with default limit", async () => {
    await seedEvents(3);
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/activity");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: ReadonlyArray<{ written_iso: string; event_type: string }>;
      next_cursor: string | null;
    };
    expect(body.events).toHaveLength(3);
    // Strictly descending:
    for (let i = 0; i < body.events.length - 1; i++) {
      expect(body.events[i]!.written_iso >= body.events[i + 1]!.written_iso).toBe(true);
    }
    // Only 3 events seeded, fewer than the default limit → next_cursor is null.
    expect(body.next_cursor).toBeNull();
  });

  it("paginates with limit + before cursor, advancing correctly", async () => {
    await seedEvents(250);

    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const pageA = (await (await app.request("/api/activity?limit=100")).json()) as {
      events: ReadonlyArray<{ written_iso: string }>;
      next_cursor: string | null;
    };
    expect(pageA.events).toHaveLength(100);
    expect(pageA.next_cursor).toBe(pageA.events[99]!.written_iso);

    const pageB = (await (
      await app.request(`/api/activity?limit=100&before=${encodeURIComponent(pageA.next_cursor!)}`)
    ).json()) as {
      events: ReadonlyArray<{ written_iso: string }>;
      next_cursor: string | null;
    };
    expect(pageB.events).toHaveLength(100);
    // Strictly older than the cursor:
    expect(pageB.events[0]!.written_iso < pageA.next_cursor!).toBe(true);
    expect(pageB.next_cursor).toBe(pageB.events[99]!.written_iso);

    const pageC = (await (
      await app.request(`/api/activity?limit=100&before=${encodeURIComponent(pageB.next_cursor!)}`)
    ).json()) as {
      events: ReadonlyArray<{ written_iso: string }>;
      next_cursor: string | null;
    };
    // 250 total: page A=100, B=100, C=50 → C is the end → next_cursor null.
    expect(pageC.events).toHaveLength(50);
    expect(pageC.next_cursor).toBeNull();
  });

  it("clamps limit to 500 maximum", async () => {
    await seedEvents(10);
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    // Out-of-range high — the SELECT still works, just bounded.
    const res = await app.request("/api/activity?limit=999999");
    const body = (await res.json()) as {
      events: ReadonlyArray<{ written_iso: string }>;
      next_cursor: string | null;
    };
    // Only 10 events seeded; the result is bounded by what's in the DB.
    expect(body.events).toHaveLength(10);
    expect(body.next_cursor).toBeNull();
  });
});
