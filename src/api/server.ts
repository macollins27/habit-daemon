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
import { serializeHabit, type HabitResponse } from "./serialize.js";

export interface ApiDeps {
  readonly sessionStore: SessionStore;
}

export interface HabitListItem extends HabitResponse {
  readonly today_run: {
    readonly id: string;
    readonly status: string;
    readonly current_level: number;
  } | null;
}

interface HabitListJoinRow extends Record<string, unknown> {
  readonly _today_run_id: string | null;
  readonly _today_status: string | null;
  readonly _today_level: number | null;
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
    return c.json({ heartbeat_age_seconds: 0 });
  });

  // GET /api/habits — list habits with today's run join.
  //
  // The LEFT JOIN against `habit_runs` filters on `fire_date = date('now')`
  // so each row carries at most one "today" run (the schema's
  // UNIQUE(habit_id, fire_date) makes this deterministic). The four
  // `_today_*` aliases are stripped by the serializer downstream and
  // re-emitted as a structured `today_run` object on the response.
  //
  // Ordering: descending `created_at` so the freshest habits surface first
  // in the chat / web UI. Archive filter is opt-out via
  // `?include_archived=1`.
  app.get("/api/habits", (c) => {
    const includeArchived = c.req.query("include_archived") === "1";
    const where = includeArchived ? "" : "WHERE h.archived_at IS NULL";
    const rows = deps.sessionStore.db
      .prepare(
        `SELECT h.*,
                hr.id            AS _today_run_id,
                hr.status        AS _today_status,
                hr.current_level AS _today_level
         FROM habits h
         LEFT JOIN habit_runs hr
           ON hr.habit_id = h.id
          AND hr.fire_date = date('now')
         ${where}
         ORDER BY h.created_at DESC`,
      )
      .all() as ReadonlyArray<HabitListJoinRow>;
    const habits: ReadonlyArray<HabitListItem> = rows.map((r) => {
      const serialized = serializeHabit(r);
      const todayRun: HabitListItem["today_run"] =
        r._today_run_id !== null &&
        r._today_status !== null &&
        r._today_level !== null
          ? {
              id: r._today_run_id,
              status: r._today_status,
              current_level: r._today_level,
            }
          : null;
      return { ...serialized, today_run: todayRun };
    });
    return c.json({ habits });
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
