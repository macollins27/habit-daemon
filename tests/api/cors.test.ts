/**
 * CORS middleware — deny-by-default, allow only the configured SPA_ORIGIN.
 *
 * The middleware is wired so that:
 *   - No `SPA_ORIGIN` env var      → no `Access-Control-Allow-Origin` header
 *     emitted on any request, regardless of the request's `Origin` header.
 *   - `SPA_ORIGIN` set + matching   → the allow header is set to that origin
 *   - `SPA_ORIGIN` set + mismatch   → no allow header
 *   - OPTIONS preflight             → 204 with the full preflight headers
 *
 * Each test mutates `process.env.SPA_ORIGIN` and restores it in `afterEach`
 * so test order does not leak env state.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { setupHabitDb, type HabitDbHandle } from "./_helpers.js";

let handle: HabitDbHandle;
const ORIGINAL_SPA_ORIGIN = process.env.SPA_ORIGIN;

beforeEach(async () => {
  handle = await setupHabitDb();
});

afterEach(() => {
  handle.cleanup();
  // Restore the original env var (or remove if it was unset).
  if (ORIGINAL_SPA_ORIGIN === undefined) {
    delete process.env.SPA_ORIGIN;
  } else {
    process.env.SPA_ORIGIN = ORIGINAL_SPA_ORIGIN;
  }
});

describe("CORS middleware on /api/*", () => {
  it("emits no allow-origin header when SPA_ORIGIN is unset", async () => {
    delete process.env.SPA_ORIGIN;
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/health", {
      headers: { Origin: "https://example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("emits allow-origin = SPA_ORIGIN when the request Origin matches", async () => {
    process.env.SPA_ORIGIN = "https://app.example.com";
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/health", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
  });

  it("emits no allow-origin header when the request Origin does not match", async () => {
    process.env.SPA_ORIGIN = "https://app.example.com";
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/health", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("OPTIONS preflight returns 204 with the expected headers when origin matches", async () => {
    process.env.SPA_ORIGIN = "https://app.example.com";
    const app = buildApp({ sessionStore: handle.ledger.sessionStore });
    const res = await app.request("/api/habits", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("access-control-allow-methods")).not.toBeNull();
  });
});
