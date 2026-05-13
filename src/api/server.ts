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
import { z } from "zod";
import type { SessionStore } from "../daemon/session-store.js";
import { serializeHabit, type HabitResponse } from "./serialize.js";
import { computeStats, type HabitRunForStats } from "./stats.js";

// Bounded limit for the /runs endpoint. Defaults to 30, max 365 — values
// outside the range are clamped (not rejected) so a UI passing an
// out-of-bounds value still gets a useful response.
const RUNS_LIMIT_DEFAULT = 30;
const RUNS_LIMIT_MAX = 365;

const RunsQuerySchema = z.object({
  since: z.string().min(1).optional(),
  limit: z
    .string()
    .optional()
    .transform((s): number => {
      if (s === undefined) return RUNS_LIMIT_DEFAULT;
      const n = Number.parseInt(s, 10);
      if (!Number.isFinite(n) || n <= 0) return RUNS_LIMIT_DEFAULT;
      return Math.min(n, RUNS_LIMIT_MAX);
    }),
});

interface HabitRunRow {
  readonly id: string;
  readonly fire_date: string;
  readonly status: string;
  readonly current_level: number;
  readonly next_escalation_at: number | null;
  readonly miss_reason: string | null;
}

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

  // GET /api/habits/:id — fetch a single habit.
  //
  // Returns archived rows too: callers that drill in by id (e.g. an
  // unarchive UI) need to see the row regardless of `archived_at`.
  // 404 with a structured `{ error }` body when the id is unknown so
  // the chat / web UI can surface a clean message without trying to
  // parse an empty response.
  app.get("/api/habits/:id", (c) => {
    const id = c.req.param("id");
    const row = deps.sessionStore.db
      .prepare(`SELECT * FROM habits WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return c.json({ error: `unknown habit id: ${id}` }, 404);
    }
    return c.json(serializeHabit(row));
  });

  // GET /api/habits/:id/runs — paginated history of a habit's runs.
  //
  // `miss_reason` is left-joined from `miss_reasons` so a row missing
  // a classification still surfaces (with `miss_reason: null`). When
  // multiple miss_reasons exist for the same run (rare, but possible
  // when an L3 retry overwrites the prior classification), the most
  // recently inserted row wins via `MAX(created_at)`.
  app.get("/api/habits/:id/runs", (c) => {
    const id = c.req.param("id");
    const parsed = RunsQuerySchema.safeParse({
      since: c.req.query("since"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid query parameters" }, 400);
    }
    const { since, limit } = parsed.data;

    // The `miss_reasons` correlated subquery picks the latest classification
    // per run. Using MAX(created_at) (rather than ORDER BY ... LIMIT 1)
    // lets SQLite evaluate it as an aggregate against the per-run group.
    const whereSince = since !== undefined ? "AND hr.fire_date >= ?" : "";
    const stmt = deps.sessionStore.db.prepare(
      `SELECT hr.id, hr.fire_date, hr.status, hr.current_level,
              hr.next_escalation_at,
              (SELECT mr.classification
                 FROM miss_reasons mr
                WHERE mr.run_id = hr.id
                ORDER BY mr.created_at DESC
                LIMIT 1) AS miss_reason
         FROM habit_runs hr
        WHERE hr.habit_id = ?
          ${whereSince}
        ORDER BY hr.fire_date DESC
        LIMIT ?`,
    );
    const rows = (since !== undefined
      ? stmt.all(id, since, limit)
      : stmt.all(id, limit)) as ReadonlyArray<HabitRunRow>;
    return c.json({ runs: rows });
  });

  // GET /api/habits/:id/stats — completion-rate + streak math.
  //
  // SELECTs the entire run history (no LIMIT) so streak math sees the
  // full sequence. For habits with thousands of runs this would warrant
  // a server-side rollup; Phase A volumes are well below that bar.
  // 404 surfaces an unknown habit id distinct from "habit exists but
  // has zero runs" (which returns zeros).
  app.get("/api/habits/:id/stats", (c) => {
    const id = c.req.param("id");
    const habit = deps.sessionStore.db
      .prepare(`SELECT id FROM habits WHERE id = ?`)
      .get(id) as { id: string } | undefined;
    if (habit === undefined) {
      return c.json({ error: `unknown habit id: ${id}` }, 404);
    }
    const rows = deps.sessionStore.db
      .prepare(
        `SELECT fire_date, status FROM habit_runs WHERE habit_id = ?`,
      )
      .all(id) as ReadonlyArray<HabitRunForStats>;
    return c.json(computeStats(rows));
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
