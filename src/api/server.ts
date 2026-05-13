/**
 * Hono-backed HTTP API for the habit-daemon.
 *
 * Two entry points:
 *   - `buildApp({ sessionStore })` returns a fresh `Hono` instance with all
 *     routes wired up against the supplied dependencies. It is a pure
 *     factory: no global state, safe to call repeatedly in tests. Routes
 *     are mounted under `/api/*`.
 *   - `startServer({ deps, port? })` binds a Node HTTP listener via
 *     `@hono/node-server`. The official adapter is preferred over a
 *     hand-rolled `http.createServer` wrapper because it streams the
 *     Hono response directly to the Node socket and handles edge cases
 *     (HEAD, abort, large bodies) that we don't want to re-implement.
 *
 * Naming bridge:
 *   The HTTP surface exposes the public API field names defined in
 *   `src/api/schemas.ts` (`display_name`, `cadence`, `proof_config`,
 *   `why_stakes`), never the underlying DB column names. The translation
 *   is centralised in `src/api/serialize.ts` so that every read endpoint
 *   uses the same mapping.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { SessionStore } from "../daemon/session-store.js";

export interface ApiDeps {
  readonly sessionStore: SessionStore;
}

export interface StartServerOptions {
  readonly deps: ApiDeps;
  readonly port?: number;
}

export interface ServerHandle {
  readonly close: () => void;
}

export function buildApp(deps: ApiDeps): Hono {
  // Each call must return a fresh instance — tests assert independence.
  // We intentionally do not memoize or share routers across builds.
  // The `deps` parameter is unused in the skeleton but threaded so that
  // subsequent endpoints (GET /api/habits, etc.) can read from the
  // SessionStore via the closure without reaching for module-level
  // singletons.
  const app = new Hono();

  app.get("/api/health", (c) => {
    // Placeholder: Task 2.10 will compute heartbeat age from the daemon
    // heartbeat file/row. The shape must already carry the field so the
    // chat / web UI can wire up its consumer without waiting for the
    // enrichment.
    void deps;
    return c.json({ heartbeat_age_seconds: 0 });
  });

  return app;
}

export function startServer(opts: StartServerOptions): ServerHandle {
  const app = buildApp(opts.deps);
  const port = opts.port ?? 8787;
  const server = serve({ fetch: app.fetch, port });
  return {
    close: () => {
      server.close();
    },
  };
}
