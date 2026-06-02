/**
 * GET /api/health — rich daemon-status payload.
 *
 * Field sources:
 *   - heartbeat_age_seconds / last_tick_iso: file mtime of `heartbeatPath`
 *     dep, null when the file does not exist
 *   - discord_connected: `deps.discordConnected()` callback, defaults to
 *     false when the callback isn't provided (so unit tests / pre-bootstrap
 *     env can hit the endpoint without faking a Discord client)
 *   - concept2_token_expires_at: parsed from the tokens file at
 *     `concept2TokensPath`; the file stores `expires_at` as epoch ms (see
 *     `src/lib/concept2-adapter.ts::Concept2Tokens`) which we convert to ISO
 *   - last_garmin_sync_iso: `MAX(fetched_at)` from sensor_signals where
 *     `source='garmin'` (the actual column name is `source`, not `provider`
 *     — see migration 002); epoch ms → ISO
 *   - recent_dispatch_failures_24h: `COUNT(*)` from dispatches where
 *     `findings_status='FAILED'` and `dispatched_iso > now-24h` (the
 *     ledger's dispatch_iso is the start time; findings_status is the
 *     terminal failure flag)
 *
 * The `now` callback is injected so the 24h-boundary test can fix a wall
 * clock without sleeping.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utimesSync } from "node:fs";

import { buildApp } from "../../src/api/server.js";
import { setupHabitDb, type HabitDbHandle } from "./_helpers.js";

interface HealthResponseShape {
  readonly heartbeat_age_seconds: number | null;
  readonly last_tick_iso: string | null;
  readonly discord_connected: boolean;
  readonly concept2_token_expires_at: string | null;
  readonly last_garmin_sync_iso: string | null;
  readonly recent_dispatch_failures_24h: number;
}

let handle: HabitDbHandle;
let tempDir: string;

beforeEach(async () => {
  handle = await setupHabitDb();
  tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-health-test-"));
});

afterEach(() => {
  handle.cleanup();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /api/health", () => {
  it("returns the full HealthResponse shape with correct types when wired", async () => {
    // Heartbeat file with a known mtime (5 seconds ago).
    const hbPath = join(tempDir, "heartbeat");
    writeFileSync(hbPath, "1234567890 2026-05-13T00:00:00Z");
    const fiveSecAgo = Math.floor(Date.now() / 1000) - 5;
    utimesSync(hbPath, fiveSecAgo, fiveSecAgo);

    // Concept2 tokens file.
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

    // One garmin sensor_signals row.
    const garminFetchedAt = Date.now() - 60_000;
    handle.ledger.sessionStore.db
      .prepare(
        `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
         VALUES (?, 'garmin', ?, ?, ?)`,
      )
      .run("garmin-2026-05-12", "2026-05-12", "{}", garminFetchedAt);

    // Seed one run + one FAILED dispatch (within 24h window).
    handle.ledger.sessionStore.db
      .prepare(
        `INSERT INTO runs (run_id, verb, args_json, started_iso, status, git_head_sha, git_dirty)
         VALUES (?, 'noop', '{}', ?, 'failed', 'abc', 0)`,
      )
      .run("run-1", new Date().toISOString());
    handle.ledger.sessionStore.db
      .prepare(
        `INSERT INTO dispatches (
          run_id, skill, args, scope, authorized_paths_json, model,
          dispatched_iso, findings_status
        ) VALUES (?, 'demo', '{}', 'project', '[]', 'haiku', ?, 'FAILED')`,
      )
      .run("run-1", new Date().toISOString());

    const app = buildApp({
      sessionStore: handle.ledger.sessionStore,
      heartbeatPath: hbPath,
      discordConnected: (): boolean => true,
      concept2TokensPath: tokensPath,
    });

    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponseShape;

    expect(typeof body.heartbeat_age_seconds).toBe("number");
    expect(body.heartbeat_age_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof body.last_tick_iso).toBe("string");
    expect(body.discord_connected).toBe(true);
    expect(typeof body.concept2_token_expires_at).toBe("string");
    expect(body.concept2_token_expires_at).toBe(new Date(tokenExpiresAt).toISOString());
    expect(typeof body.last_garmin_sync_iso).toBe("string");
    expect(body.last_garmin_sync_iso).toBe(new Date(garminFetchedAt).toISOString());
    expect(body.recent_dispatch_failures_24h).toBe(1);
  });

  it("returns null for heartbeat fields when the file is missing", async () => {
    const missingPath = join(tempDir, "does-not-exist");
    const app = buildApp({
      sessionStore: handle.ledger.sessionStore,
      heartbeatPath: missingPath,
    });
    const res = await app.request("/api/health");
    const body = (await res.json()) as HealthResponseShape;
    expect(body.heartbeat_age_seconds).toBeNull();
    expect(body.last_tick_iso).toBeNull();
  });

  it("returns false for discord_connected when the callback is not provided", async () => {
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/health");
    const body = (await res.json()) as HealthResponseShape;
    expect(body.discord_connected).toBe(false);
  });

  it("excludes dispatch failures older than 24h", async () => {
    // Fix `now` so the boundary is deterministic.
    const fixedNow = new Date("2026-05-13T12:00:00.000Z");
    // One failure 1 hour ago (in window), one 25 hours ago (outside).
    const inWindow = new Date(fixedNow.getTime() - 60 * 60 * 1000).toISOString();
    const outsideWindow = new Date(fixedNow.getTime() - 25 * 60 * 60 * 1000).toISOString();

    handle.ledger.sessionStore.db
      .prepare(
        `INSERT INTO runs (run_id, verb, args_json, started_iso, status, git_head_sha, git_dirty)
         VALUES (?, 'noop', '{}', ?, 'failed', 'abc', 0)`,
      )
      .run("run-old", "2026-05-12T00:00:00.000Z");

    handle.ledger.sessionStore.db
      .prepare(
        `INSERT INTO dispatches (
          run_id, skill, args, scope, authorized_paths_json, model,
          dispatched_iso, findings_status
        ) VALUES
          (?, 'a', '{}', 'project', '[]', 'h', ?, 'FAILED'),
          (?, 'b', '{}', 'project', '[]', 'h', ?, 'FAILED'),
          (?, 'c', '{}', 'project', '[]', 'h', ?, 'CLEAN')`,
      )
      .run("run-old", inWindow, "run-old", outsideWindow, "run-old", inWindow);

    const app = buildApp({
      sessionStore: handle.ledger.sessionStore,
      now: (): Date => fixedNow,
    });
    const res = await app.request("/api/health");
    const body = (await res.json()) as HealthResponseShape;
    // Only the in-window FAILED row counts (the CLEAN row is filtered out
    // and the 25h-old FAILED row is outside the window).
    expect(body.recent_dispatch_failures_24h).toBe(1);
  });

  it("returns last_garmin_sync_iso as the most recent sensor_signals row for source=garmin", async () => {
    const older = Date.now() - 24 * 3600 * 1000;
    const newer = Date.now() - 60 * 1000;
    handle.ledger.sessionStore.db
      .prepare(
        `INSERT INTO sensor_signals (id, source, payload_date, payload_json, fetched_at)
         VALUES
           (?, 'garmin', '2026-05-11', '{}', ?),
           (?, 'garmin', '2026-05-12', '{}', ?),
           (?, 'concept2', '2026-05-12', '{}', ?)`,
      )
      .run(
        "garmin-2026-05-11",
        older,
        "garmin-2026-05-12",
        newer,
        "concept2-2026-05-12",
        Date.now(), // concept2, more recent — must NOT count.
      );

    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/health");
    const body = (await res.json()) as HealthResponseShape;
    expect(body.last_garmin_sync_iso).toBe(new Date(newer).toISOString());
  });

  it("returns null for last_garmin_sync_iso when no garmin rows exist", async () => {
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/health");
    const body = (await res.json()) as HealthResponseShape;
    expect(body.last_garmin_sync_iso).toBeNull();
  });

  it("returns null for concept2_token_expires_at when the tokens file is missing or unparseable", async () => {
    const missingPath = join(tempDir, "no-such-tokens.json");
    const app = buildApp({
      sessionStore: handle.ledger.sessionStore,
      concept2TokensPath: missingPath,
    });
    const res = await app.request("/api/health");
    const body = (await res.json()) as HealthResponseShape;
    expect(body.concept2_token_expires_at).toBeNull();

    // Malformed JSON also yields null (not 500).
    const badPath = join(tempDir, "bad-tokens.json");
    writeFileSync(badPath, "{not-json");
    const app2 = buildApp({
      sessionStore: handle.ledger.sessionStore,
      concept2TokensPath: badPath,
    });
    const res2 = await app2.request("/api/health");
    const body2 = (await res2.json()) as HealthResponseShape;
    expect(body2.concept2_token_expires_at).toBeNull();
  });
});
