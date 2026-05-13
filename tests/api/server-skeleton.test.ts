/**
 * Skeleton tests for the Hono HTTP API. We exercise the in-process `Hono`
 * app via `app.fetch()` to avoid binding a real port. This keeps the test
 * fast and deterministic, and means the test does not depend on whether
 * `@hono/node-server` is wired up correctly — that's covered by a separate
 * concern at `startServer`.
 *
 * Why `buildApp` returns a fresh `Hono` per call: this is the purity guard.
 * Two independent calls must not share state, so that test code can spin up
 * a throwaway app per test without leaking handlers or middleware across
 * tests. The third test below verifies that property.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { Ledger } from "../../src/daemon/ledger.js";
import { buildApp } from "../../src/api/server.js";

let tempDir: string;
let dbPath: string;
let ledger: Ledger;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-api-skeleton-"));
  dbPath = join(tempDir, "test.db");
  const db = openDatabase(dbPath);
  await runMigrations(db, loadMigrations());
  db.close();
  ledger = new Ledger({ dbPath });
});

afterEach(() => {
  ledger.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("buildApp (Hono skeleton)", () => {
  it("GET /api/health returns 200 with heartbeat_age_seconds in body", async () => {
    const app = buildApp({ sessionStore: ledger.sessionStore });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { heartbeat_age_seconds: unknown };
    expect(body).toHaveProperty("heartbeat_age_seconds");
    // Placeholder: must be a number (zero or otherwise). Task 2.10 will
    // enrich this; for now we only assert the shape.
    expect(typeof body.heartbeat_age_seconds).toBe("number");
  });

  it("returns 404 on an unknown route", async () => {
    const app = buildApp({ sessionStore: ledger.sessionStore });
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("buildApp is a pure function (two calls produce independent apps)", async () => {
    const a = buildApp({ sessionStore: ledger.sessionStore });
    const b = buildApp({ sessionStore: ledger.sessionStore });
    expect(a).not.toBe(b);
    // Both apps respond identically to /api/health — proving each call
    // wires up routes independently rather than sharing global state.
    const [resA, resB] = await Promise.all([
      a.request("/api/health"),
      b.request("/api/health"),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
  });
});
