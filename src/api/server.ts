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
import { statSync, readFileSync } from "node:fs";
import type { SessionStore } from "../daemon/session-store.js";
import { serializeHabit, type HabitResponse } from "./serialize.js";
import { computeStats, type HabitRunForStats } from "./stats.js";
import { HabitCreateInput, HabitPatchInput } from "./schemas.js";
import { createHabit } from "../orchestrate/create-habit.js";
import { updateHabit } from "../orchestrate/update-habit.js";
import { archiveHabit, unarchiveHabit } from "../orchestrate/archive-habit.js";

// Bounded limit for the /runs endpoint. Defaults to 30, max 365 — values
// outside the range are clamped (not rejected) so a UI passing an
// out-of-bounds value still gets a useful response.
const RUNS_LIMIT_DEFAULT = 30;
const RUNS_LIMIT_MAX = 365;

// Bounded limit for the /activity endpoint. Default 100, max 500.
const ACTIVITY_LIMIT_DEFAULT = 100;
const ACTIVITY_LIMIT_MAX = 500;

const ActivityQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z
    .string()
    .optional()
    .transform((s): number => {
      if (s === undefined) return ACTIVITY_LIMIT_DEFAULT;
      const n = Number.parseInt(s, 10);
      if (!Number.isFinite(n) || n <= 0) return ACTIVITY_LIMIT_DEFAULT;
      return Math.min(n, ACTIVITY_LIMIT_MAX);
    }),
});

interface ActivityEventRow {
  readonly id: number;
  readonly session_id: string;
  readonly seq: number;
  readonly event_json: string;
  readonly event_type: string | null;
  readonly trust_level: string;
  readonly written_iso: string;
}

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
  /**
   * Path to the daemon's heartbeat file (mtime → freshness). Optional —
   * when omitted the /api/health endpoint reports heartbeat as null.
   * Production wires this from `src/daemon/heartbeat.ts::resolveHeartbeatPath`.
   */
  readonly heartbeatPath?: string;
  /**
   * Snapshot of the live Discord adapter's connected state. Optional —
   * defaults to `() => false` so pre-bootstrap envs / tests can hit the
   * endpoint without faking a Discord client. The daemon wires the real
   * adapter callback at startup.
   */
  readonly discordConnected?: () => boolean;
  /**
   * Path to the persisted Concept2 OAuth tokens file. Optional — when the
   * file is missing or malformed the /api/health endpoint reports the
   * `concept2_token_expires_at` field as null rather than 500-ing.
   */
  readonly concept2TokensPath?: string;
  /**
   * Wall-clock injection seam so the 24h failures-window boundary is
   * deterministically testable. Defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
}

export interface HealthResponse {
  readonly heartbeat_age_seconds: number | null;
  readonly last_tick_iso: string | null;
  readonly discord_connected: boolean;
  readonly concept2_token_expires_at: string | null;
  readonly last_garmin_sync_iso: string | null;
  readonly recent_dispatch_failures_24h: number;
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

/**
 * Read the heartbeat file's mtime and translate it into the health
 * payload's `heartbeat_age_seconds` / `last_tick_iso` pair. Returns nulls
 * when the file is missing OR cannot be stat'd — both cases are recoverable
 * states for a freshly-installed daemon and must not 500 the endpoint.
 */
function readHeartbeat(
  heartbeatPath: string | undefined,
  now: Date,
): { ageSec: number | null; lastTickIso: string | null } {
  if (heartbeatPath === undefined) {
    return { ageSec: null, lastTickIso: null };
  }
  try {
    const st = statSync(heartbeatPath);
    const mtimeMs = st.mtimeMs;
    const ageSec = Math.max(0, Math.floor((now.getTime() - mtimeMs) / 1000));
    return { ageSec, lastTickIso: new Date(mtimeMs).toISOString() };
  } catch {
    return { ageSec: null, lastTickIso: null };
  }
}

/**
 * Parse the persisted Concept2 tokens file and convert the stored epoch-ms
 * `expires_at` to an ISO timestamp. Returns null on missing-file, malformed
 * JSON, or a non-numeric `expires_at` — the health endpoint should never
 * 500 on a credential-surface read.
 */
function readConcept2Expiry(tokensPath: string | undefined): string | null {
  if (tokensPath === undefined) return null;
  try {
    const raw = readFileSync(tokensPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const expiresAt = (parsed as Record<string, unknown>)["expires_at"];
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
      return null;
    }
    return new Date(expiresAt).toISOString();
  } catch {
    return null;
  }
}

interface MaxFetchedAtRow {
  readonly max_fetched_at: number | null;
}

interface FailuresCountRow {
  readonly n: number;
}

/**
 * Aggregate every health field into a single HealthResponse. Pure (apart
 * from filesystem reads + the SessionStore query) and synchronous — the
 * /api/health route is a thin wrapper.
 */
function computeHealth(deps: ApiDeps, now: Date): HealthResponse {
  const { ageSec, lastTickIso } = readHeartbeat(deps.heartbeatPath, now);
  const concept2Expiry = readConcept2Expiry(deps.concept2TokensPath);
  const discordConnected = deps.discordConnected?.() ?? false;

  const garminRow = deps.sessionStore.db
    .prepare(
      `SELECT MAX(fetched_at) AS max_fetched_at
         FROM sensor_signals
        WHERE source = 'garmin'`,
    )
    .get() as MaxFetchedAtRow | undefined;
  const lastGarminSyncIso =
    garminRow && typeof garminRow.max_fetched_at === "number"
      ? new Date(garminRow.max_fetched_at).toISOString()
      : null;

  // 24h cutoff for failed dispatches. `dispatched_iso` is the start ISO
  // string per the ledger schema — lexicographic comparison on
  // ISO-8601 strings is equivalent to chronological comparison, so a
  // plain SQL `>` works without parsing.
  const cutoffIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const failuresRow = deps.sessionStore.db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM dispatches
        WHERE findings_status = 'FAILED'
          AND dispatched_iso > ?`,
    )
    .get(cutoffIso) as FailuresCountRow;

  return {
    heartbeat_age_seconds: ageSec,
    last_tick_iso: lastTickIso,
    discord_connected: discordConnected,
    concept2_token_expires_at: concept2Expiry,
    last_garmin_sync_iso: lastGarminSyncIso,
    recent_dispatch_failures_24h: failuresRow.n,
  };
}

export function buildApp(deps: ApiDeps): Hono {
  // Each call must return a fresh instance — tests assert independence.
  // We intentionally do not memoize or share routers across builds.
  // The `deps` parameter is unused in the skeleton but threaded so that
  // subsequent endpoints (GET /api/habits, etc.) can read from the
  // SessionStore via the closure without reaching for module-level
  // singletons.
  const app = new Hono();

  // GET /api/health — daemon liveness + sensor freshness payload.
  //
  // Every field is independently nullable so a partially-failed daemon
  // (e.g., heartbeat file missing but DB up) still returns a structurally
  // valid 200 response. Specific source-of-truth per field:
  //   - heartbeat_age_seconds / last_tick_iso ← deps.heartbeatPath mtime
  //   - discord_connected                     ← deps.discordConnected?.()
  //   - concept2_token_expires_at             ← deps.concept2TokensPath JSON
  //   - last_garmin_sync_iso                  ← MAX(sensor_signals.fetched_at)
  //                                              filtered to source='garmin'
  //                                              (the actual column is `source`
  //                                              per migration 002, NOT `provider`)
  //   - recent_dispatch_failures_24h          ← COUNT(*) from dispatches
  //                                              where findings_status='FAILED'
  //                                              and dispatched_iso > now-24h
  //
  // The `now` injection seam keeps the 24h-window boundary deterministic
  // under test.
  app.get("/api/health", (c) => {
    const now = (deps.now ?? ((): Date => new Date()))();
    const health = computeHealth(deps, now);
    return c.json(health);
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

  // POST /api/habits — create a new habit.
  //
  // The orchestrator (`createHabit`) is the single source of truth for
  // validation, ID derivation (`habit_` + slug), and the audit-event write.
  // We perform an outer `safeParse` so a malformed body produces a 400 with
  // Zod's `.format()` shape instead of letting the orchestrator's inner
  // `.parse()` throw a ZodError (which would surface as a 500). Both checks
  // are cheap and structurally identical; the outer one only exists to
  // bridge "throw" → "structured 400".
  //
  // Error-message-based status branching mirrors the exact substrings the
  // orchestrator throws (see `src/orchestrate/create-habit.ts`):
  //   "habit slug already exists"  → 409
  //   "invalid cron expression"    → 400
  // Anything else re-throws to the framework's default 500 handler.
  app.post("/api/habits", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = HabitCreateInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.format() }, 400);
    }
    try {
      const result = createHabit({
        sessionStore: deps.sessionStore,
        input: parsed.data,
      });
      return c.json({ id: result.id }, 201);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("slug already exists")) {
        return c.json({ error: msg }, 409);
      }
      if (msg.includes("invalid cron")) {
        return c.json({ error: msg }, 400);
      }
      throw err;
    }
  });

  // PATCH /api/habits/:id — partial update.
  //
  // Maps orchestrator throws:
  //   "unknown habit id"       → 404
  //   "patch is empty"         → 400
  //   "invalid cron expression"→ 400
  //   "slug is immutable"      → 400
  // Returns 204 on success (no body), matching standard REST conventions
  // for idempotent partial-mutating endpoints.
  app.patch("/api/habits/:id", async (c) => {
    const id = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = HabitPatchInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.format() }, 400);
    }
    try {
      updateHabit({
        sessionStore: deps.sessionStore,
        id,
        patch: parsed.data,
      });
      return c.body(null, 204);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown habit id")) {
        return c.json({ error: msg }, 404);
      }
      if (msg.includes("patch is empty")) {
        return c.json({ error: msg }, 400);
      }
      if (msg.includes("invalid cron")) {
        return c.json({ error: msg }, 400);
      }
      if (msg.includes("slug is immutable")) {
        return c.json({ error: msg }, 400);
      }
      throw err;
    }
  });

  // DELETE /api/habits/:id — soft-delete (archive).
  //
  // Idempotent: re-deleting an already-archived row is a silent no-op in
  // `archiveHabit`, so a second DELETE still returns 204. Unknown-id is
  // 404 (matches the orchestrator's hard throw — distinct from the silent
  // already-archived path).
  app.delete("/api/habits/:id", (c) => {
    const id = c.req.param("id");
    try {
      archiveHabit({ sessionStore: deps.sessionStore, id });
      return c.body(null, 204);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown habit id")) {
        return c.json({ error: msg }, 404);
      }
      throw err;
    }
  });

  // POST /api/habits/:id/unarchive — restore a soft-deleted habit.
  //
  // Idempotent in the same shape as DELETE: re-unarchiving an active row
  // is a silent no-op (`unarchiveHabit`). Distinct route rather than a
  // PATCH because the state transition is a discrete, non-partial verb.
  app.post("/api/habits/:id/unarchive", (c) => {
    const id = c.req.param("id");
    try {
      unarchiveHabit({ sessionStore: deps.sessionStore, id });
      return c.body(null, 204);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown habit id")) {
        return c.json({ error: msg }, 404);
      }
      throw err;
    }
  });

  // GET /api/activity — cursor-paginated recent-activity feed.
  //
  // Cursor: `written_iso` of the last event in the response. The next
  // request passes it as `?before=<written_iso>` to fetch the next
  // older page. `next_cursor` is null when the page is short (i.e. we
  // returned fewer rows than the requested limit), signalling the end
  // of the feed.
  //
  // The index `idx_session_events_written_iso_desc` (migration 004)
  // makes the descending sort O(limit) without a sort step.
  app.get("/api/activity", (c) => {
    const parsed = ActivityQuerySchema.safeParse({
      before: c.req.query("before"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid query parameters" }, 400);
    }
    const { before, limit } = parsed.data;
    const whereBefore = before !== undefined ? "WHERE written_iso < ?" : "";
    const stmt = deps.sessionStore.db.prepare(
      `SELECT id, session_id, seq, event_json, event_type, trust_level, written_iso
         FROM session_events
         ${whereBefore}
        ORDER BY written_iso DESC
        LIMIT ?`,
    );
    const rows = (before !== undefined
      ? stmt.all(before, limit)
      : stmt.all(limit)) as ReadonlyArray<ActivityEventRow>;
    const nextCursor =
      rows.length < limit ? null : (rows[rows.length - 1]?.written_iso ?? null);
    return c.json({ events: rows, next_cursor: nextCursor });
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
