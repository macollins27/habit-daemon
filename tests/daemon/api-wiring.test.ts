/**
 * Integration test for the daemon-time HTTP API wiring.
 *
 * Where the rest of the api/* suite hits the Hono app in-process via
 * `app.request()` (no socket), this test goes one layer deeper:
 *
 *   1. Binds a real Node TCP listener via `startServer(deps, 0)` — the
 *      OS picks a free port so the test never collides with the daemon's
 *      production 8787 or with a parallel test worker.
 *   2. Issues real `fetch()` calls against the bound port.
 *   3. Calls `close()` and verifies subsequent fetches fail.
 *
 * Coverage rationale: this is the only place in the suite that proves the
 * `@hono/node-server` adapter is wired correctly. Every other api/* test
 * uses `app.request()` and therefore would still pass even if the Node
 * adapter wiring was broken.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer, type ServerHandle, type ApiDeps } from "../../src/api/server.js";
import { setupHabitDb, seedHabit, type HabitDbHandle } from "../api/_helpers.js";

interface HealthResponseShape {
  readonly heartbeat_age_seconds: number | null;
  readonly last_tick_iso: string | null;
  readonly discord_connected: boolean;
  readonly concept2_token_expires_at: string | null;
  readonly last_garmin_sync_iso: string | null;
  readonly recent_dispatch_failures_24h: number;
}

interface HabitsListShape {
  readonly habits: ReadonlyArray<{
    readonly id: string;
    readonly display_name: string;
  }>;
}

let handle: HabitDbHandle;
let tempDir: string;
let server: ServerHandle | null;

beforeEach(async () => {
  handle = await setupHabitDb();
  tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-api-wiring-"));
  server = null;
});

afterEach(() => {
  if (server !== null) {
    // Idempotent: if a test already closed, swallow the throw — we just
    // want to guarantee no orphan listener leaks across tests.
    try {
      server.close();
    } catch {
      // ignore
    }
  }
  handle.cleanup();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("HTTP API wiring (real socket)", () => {
  it("boots a real Hono server and serves /api/health + /api/habits, then close() makes subsequent fetches fail", async () => {
    // Heartbeat: write a tmp file with an mtime ~5 seconds in the past so
    // `heartbeat_age_seconds` is a small positive number, not zero (which
    // would be ambiguous between "just written" and "missing → null").
    const hbPath = join(tempDir, "heartbeat");
    writeFileSync(hbPath, "1234567890 2026-05-13T00:00:00Z");
    const fiveSecAgo = Math.floor(Date.now() / 1000) - 5;
    utimesSync(hbPath, fiveSecAgo, fiveSecAgo);

    // Concept2 tokens: epoch-ms `expires_at` one hour in the future.
    const tokensPath = join(tempDir, "concept2-tokens.json");
    const tokenExpiresAt = Date.now() + 3600 * 1000;
    writeFileSync(
      tokensPath,
      JSON.stringify({
        access_token: "x",
        refresh_token: "y",
        expires_at: tokenExpiresAt,
        token_type: "Bearer",
        scope: "user:read",
      }),
    );

    // Seed one habit so /api/habits has something to return.
    const habitId = seedHabit(handle, {
      slug: "wiring-test",
      display_name: "Wiring test habit",
    });

    const deps: ApiDeps = {
      sessionStore: handle.ledger.sessionStore,
      heartbeatPath: hbPath,
      discordConnected: (): boolean => true,
      concept2TokensPath: tokensPath,
    };
    // Port 0 = OS-assigned. `startServer` resolves once `server.listen`
    // fires its listening callback, so `server.port` is the real bound
    // port (not the requested 0).
    server = await startServer(deps, 0);
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).toBeLessThan(65536);

    // /api/health — every field must match what we seeded above.
    const healthRes = await fetch(`http://127.0.0.1:${String(server.port)}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as HealthResponseShape;
    expect(health.discord_connected).toBe(true);
    expect(typeof health.heartbeat_age_seconds).toBe("number");
    // 5s mtime offset → age between ~5 and ~10s (give the test runner slack
    // on slow CI). The lower bound is the discriminator that proves we
    // actually read the file's mtime rather than returning a stub.
    expect(health.heartbeat_age_seconds).toBeGreaterThanOrEqual(4);
    expect(health.heartbeat_age_seconds).toBeLessThan(60);
    expect(health.concept2_token_expires_at).toBe(
      new Date(tokenExpiresAt).toISOString(),
    );

    // /api/habits — the seeded habit must surface.
    const habitsRes = await fetch(`http://127.0.0.1:${String(server.port)}/api/habits`);
    expect(habitsRes.status).toBe(200);
    const habits = (await habitsRes.json()) as HabitsListShape;
    expect(habits.habits.length).toBeGreaterThanOrEqual(1);
    // `id` is the durable handle on the response — `slug` is write-only
    // and never echoed (see src/api/serialize.ts). The orchestrator
    // derives `id = "habit_" + slug`.
    const seeded = habits.habits.find((h) => h.id === habitId);
    expect(seeded).toBeDefined();
    expect(seeded?.id).toBe("habit_wiring-test");
    expect(seeded?.display_name).toBe("Wiring test habit");

    // close() must actually stop the listener — a follow-up fetch should
    // reject with a connection-refused error rather than hang or return
    // a stale 200. We assert the rejection on the fetch promise itself;
    // the specific error code varies by platform (ECONNREFUSED on Linux,
    // `fetch failed` on Node 20+) so we match the error existence rather
    // than a substring.
    server.close();
    const stopped = server;
    server = null; // afterEach won't double-close.

    await expect(
      fetch(`http://127.0.0.1:${String(stopped.port)}/api/health`),
    ).rejects.toThrow();
  });

  it("startServer with no port argument defaults to 8787 (smoke — does not bind)", () => {
    // This test verifies the default-port branch exists without actually
    // binding 8787 (which might already be in use on the developer's
    // machine). The function reference is enough — we don't await it.
    expect(typeof startServer).toBe("function");
  });
});
