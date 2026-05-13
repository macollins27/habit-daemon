/**
 * Daemon bootstrap. Constructs the in-process verb dispatch map that scheduler-
 * daemon.ts uses in place of the placeholder `bin/dispatch` subprocess.
 *
 * Responsibilities:
 *   1. Load env from `~/.habit-daemon/env` (NODE-side; the launchd plist only
 *      sets NODE_ENV).
 *   2. Open the SQLite ledger (creates schema via Ledger + SessionStore).
 *   3. Run forward migrations (001/002/003) idempotently.
 *   4. Seed the three habits (idempotent INSERT OR REPLACE).
 *   5. Construct the Discord adapter and log in the bot client.
 *   6. Load Concept2 credentials + tokens; install an onTokensRefreshed
 *      callback that persists rotated tokens back to disk.
 *   7. Register cron rows in the `schedules` table:
 *      - one per habit (morning fire → create-habit-run verb)
 *      - retry-unresolved-sensors (every 6h)
 *      - evaluate-stage-b (9am daily)
 *   8. Open a daemon-process session and return the dispatch function +
 *      lifecycle handles for scheduler-daemon.ts's `main()` to use.
 *
 * The dispatch function is a switch over verb name → in-process orchestration
 * verb. No subprocess spawn for orchestration verbs. (Garmin's Python shim is
 * still spawned per ADR 0003 — that's the only persistent subprocess path.)
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { Ledger } from "./ledger.js";
import { SessionStore } from "./session-store.js";
import { runMigrations } from "../db/migrate.js";
import { loadMigrations } from "../db/load-migrations.js";
import { seedHabits } from "../db/seed-habits.js";
import {
  createDiscordAdapter,
  loadDiscordBotTokenFromEnv,
  loadDiscordChannelIdsFromEnv,
  postToChannel,
  subscribeMessages,
  type DiscordAdapter,
} from "../lib/discord-adapter.js";
import { dispatchClaude } from "./sdk-dispatch.js";
import { parseClaudeEnvelope } from "./verify-footer.js";
import {
  loadCredentials as loadConcept2Credentials,
  saveTokens as saveConcept2Tokens,
  tokensPath as concept2TokensPath,
  syncDate as concept2SyncDate,
  type Concept2Credentials,
  type Concept2Tokens,
} from "../lib/concept2-adapter.js";
import { syncDate as garminSyncDate } from "../lib/garmin-adapter.js";
import { createHabitRun } from "../orchestrate/create-habit-run.js";
import { runHabitCheckin } from "../orchestrate/habit-checkin.js";
import {
  evaluateStageB,
  registerEvaluateStageBCron,
} from "../orchestrate/evaluate-stage-b.js";
import {
  retryUnresolvedSensors,
  registerRetryUnresolvedSensorsCron,
} from "../orchestrate/retry-unresolved-sensors.js";
import { handleProofMessage } from "../orchestrate/handle-proof-message.js";
import type { DispatchFn } from "./scheduler.js";

interface HabitRow {
  readonly id: string;
  readonly cron_expr: string;
}

interface ScheduleRow {
  readonly id: number;
}

function logInfo(line: string): void {
  process.stdout.write(`[habit-daemon] ${line}\n`);
}

function logErr(line: string): void {
  process.stderr.write(`[habit-daemon] ${line}\n`);
}

/**
 * Parse a KEY=VALUE env file into process.env. Skips comments and blanks.
 * Does not overwrite values already set in the environment (so launchd
 * EnvironmentVariables block wins on conflict).
 */
function loadEnvFromHome(): string {
  const envPath = join(homedir(), ".habit-daemon", "env");
  if (!existsSync(envPath)) {
    throw new Error(
      `bootstrap: ~/.habit-daemon/env not found at ${envPath}. ` +
        `Provision per the pre-Phase-A logistics before starting the daemon.`,
    );
  }
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return envPath;
}

/**
 * Resolve the daemon's SQLite ledger path. Default: ~/.habit-daemon/state.db.
 * Override via HABIT_LEDGER_DB.
 */
function resolveLedgerDbPath(): string {
  if (process.env.HABIT_LEDGER_DB) return process.env.HABIT_LEDGER_DB;
  const stateDir = process.env.HABIT_STATE_DIR ?? join(homedir(), ".habit-daemon");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return join(stateDir, "state.db");
}

/**
 * Register one cron row per active habit. Verb is `create-habit-run`, args
 * carry the habitId. Idempotent: skips re-insertion when a row already exists
 * for (verb, habitId).
 */
function registerHabitMorningCrons(db: Database.Database): number {
  const habits = db
    .prepare(`SELECT id, cron_expr FROM habits WHERE active = 1`)
    .all() as readonly HabitRow[];

  let inserted = 0;
  for (const habit of habits) {
    const argsJson = JSON.stringify({ habitId: habit.id });
    const existing = db
      .prepare(
        `SELECT id FROM schedules
         WHERE verb = 'create-habit-run'
         AND args_json = ?`,
      )
      .get(argsJson) as ScheduleRow | undefined;
    if (existing) continue;

    db.prepare(
      `INSERT INTO schedules (cron_expr, verb, args_json, missed_run_policy, enabled, dispatch_priority)
       VALUES (?, 'create-habit-run', ?, 'skip', 1, 100)`,
    ).run(habit.cron_expr, argsJson);
    inserted++;
  }
  return inserted;
}

/**
 * Local date (process timezone) as YYYY-MM-DD. Matches the convention used by
 * the cron parser (ADR 0001) and other verbs that compute "today" / "yesterday".
 */
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface DispatchDeps {
  readonly ledger: Ledger;
  readonly adapter: DiscordAdapter;
  readonly sessionId: string;
  readonly concept2: {
    readonly credentials: Concept2Credentials;
    tokens: Concept2Tokens;
  };
}

/**
 * Wrap dispatchClaude + parseClaudeEnvelope into the shape habit-checkin
 * expects from `dispatchImpl`: returns `{structured_output?, error?}`.
 */
async function dispatchClaudeForCheckin(opts: {
  prompt: string;
  jsonSchema: string;
}): Promise<{ structured_output?: unknown; error?: string }> {
  const result = dispatchClaude({
    model: "claude-haiku-4-5-20251001",
    prompt: opts.prompt,
    jsonSchema: opts.jsonSchema,
    allowedTools: [],
    maxTurns: 1,
    maxBudgetUsd: 0.1,
  });
  if (result.status !== "success" && result.status !== "dry_run") {
    return {
      error: `claude -p exited ${result.status}: ${(result.stderr ?? "").slice(0, 500)}`,
    };
  }
  const env = parseClaudeEnvelope(result.stdout);
  if (!env.ok) return { error: env.error };
  return { structured_output: env.envelope.structured_output };
}

/**
 * Production dispatch map: verb name → in-process orchestration verb. Called
 * by scheduler-daemon.ts's dispatch callback.
 */
function makeInProcessDispatch(deps: DispatchDeps): DispatchFn {
  return async (verb: string, argsJson: string): Promise<void> => {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const now = Date.now();

    switch (verb) {
      case "create-habit-run": {
        const habitId = typeof args["habitId"] === "string" ? args["habitId"] : null;
        if (!habitId) {
          throw new Error(`create-habit-run: missing or invalid 'habitId' arg`);
        }
        const result = createHabitRun({
          db: deps.ledger.sessionStore.db,
          habitId,
          now,
          today: localDateString(new Date(now)),
        });
        logInfo(
          `create-habit-run: habitId=${habitId} runId=${result.runId} created=${String(result.created)}`,
        );
        return;
      }

      case "habit-checkin": {
        const runId = typeof args["runId"] === "string" ? args["runId"] : null;
        const currentLevel =
          typeof args["currentLevel"] === "number" ? args["currentLevel"] : null;
        if (!runId || currentLevel === null) {
          throw new Error(`habit-checkin: missing/invalid runId or currentLevel`);
        }
        const result = await runHabitCheckin({
          sessionStore: deps.ledger.sessionStore,
          adapter: deps.adapter,
          sessionId: deps.sessionId,
          runId,
          currentLevel,
          now,
          dispatchImpl: dispatchClaudeForCheckin,
        });
        logInfo(
          `habit-checkin: runId=${runId} L${currentLevel} → L${result.newLevel} dispatched=${String(result.dispatched)} calloutFired=${String(result.calloutFired)}`,
        );
        return;
      }

      case "evaluate-stage-b": {
        const result = await evaluateStageB({
          sessionStore: deps.ledger.sessionStore,
          adapter: deps.adapter,
          sessionId: deps.sessionId,
          now,
        });
        logInfo(
          `evaluate-stage-b: attempted=${String(result.attempted)} completed=${String(result.completed)} missed=${String(result.missed)} noData=${String(result.noData)}`,
        );
        return;
      }

      case "retry-unresolved-sensors": {
        const garminSync = async (date: string): Promise<void> => {
          await garminSyncDate({
            db: deps.ledger.sessionStore.db,
            date,
            pythonBin: join(homedir(), ".habit-daemon", "venv", "bin", "python"),
          });
        };
        const concept2Sync = async (date: string): Promise<void> => {
          await concept2SyncDate({
            db: deps.ledger.sessionStore.db,
            date: new Date(`${date}T00:00:00`),
            credentials: deps.concept2.credentials,
            tokens: deps.concept2.tokens,
            onTokensRefreshed: (newTokens) => {
              deps.concept2.tokens = newTokens;
              saveConcept2Tokens(newTokens);
            },
          });
        };
        const result = await retryUnresolvedSensors({
          sessionStore: deps.ledger.sessionStore,
          sessionId: deps.sessionId,
          now,
          garminSync,
          concept2Sync,
        });
        logInfo(
          `retry-unresolved-sensors: attempted=${String(result.attempted)} resolved=${String(result.resolved)} stillUnresolved=${String(result.stillUnresolved)} aged=${String(result.aged)}`,
        );
        return;
      }

      default:
        throw new Error(`Unknown verb: ${verb}`);
    }
  };
}

export interface BootstrapResult {
  readonly ledger: Ledger;
  readonly dispatch: DispatchFn;
  readonly sessionId: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Bootstrap the daemon. Loads env, opens the ledger, runs migrations, seeds
 * habits, registers cron rows, logs in the Discord client, and returns the
 * in-process dispatch function + cleanup hook for scheduler-daemon.ts.
 */
export async function bootstrap(): Promise<BootstrapResult> {
  const envPath = loadEnvFromHome();
  logInfo(`env loaded from ${envPath}`);

  const dbPath = resolveLedgerDbPath();
  logInfo(`ledger db: ${dbPath}`);
  const ledger = new Ledger({ dbPath });
  const db = ledger.sessionStore.db;

  await runMigrations(db, loadMigrations());
  logInfo(`migrations applied`);

  const channelIds = loadDiscordChannelIdsFromEnv();
  seedHabits(db, {
    morningRow: channelIds["morning-row"],
    strength: channelIds["strength"],
    windDown: channelIds["wind-down"],
  });
  logInfo(`habits seeded`);

  // Construct + log in Discord adapter. Wait for the gateway 'ready' event so
  // that subsequent posts via client.channels.fetch() don't race the
  // WebSocket connection setup.
  const adapter = createDiscordAdapter({
    botToken: loadDiscordBotTokenFromEnv(),
    channelIds,
  });
  const readyPromise = new Promise<void>((resolveReady) => {
    adapter.client.once("ready", () => {
      resolveReady();
    });
  });
  await adapter.client.login(loadDiscordBotTokenFromEnv());
  await readyPromise;
  logInfo(`discord client ready`);

  // Load Concept2 credentials + tokens. Tokens may not exist yet if the
  // one-time OAuth setup (bin/concept2-auth) hasn't been run; treat as a
  // soft warning rather than a fatal error (the retry verb's first
  // invocation will surface the issue via sensor_failure_logged).
  let concept2: DispatchDeps["concept2"] | null = null;
  try {
    const credentials = loadConcept2Credentials();
    const tokensFile = readFileSync(concept2TokensPath(), "utf8");
    const tokens = JSON.parse(tokensFile) as Concept2Tokens;
    concept2 = { credentials, tokens };
    logInfo(`concept2 credentials + tokens loaded`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(
      `concept2 credentials/tokens unavailable (${msg}); ` +
        `retry-unresolved-sensors will treat Concept2 calls as failed until ` +
        `bin/concept2-auth is run.`,
    );
  }

  // Register cron rows.
  const habitCrons = registerHabitMorningCrons(db);
  registerEvaluateStageBCron(db);
  registerRetryUnresolvedSensorsCron(db);
  logInfo(
    `cron rows registered: ${String(habitCrons)} habit fires + evaluate-stage-b + retry-unresolved-sensors`,
  );

  // Open a daemon-process session.
  const sessionId = `daemon-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  ledger.sessionStore.createSession(sessionId);
  logInfo(`daemon session: ${sessionId}`);

  // Build the dispatch map. If Concept2 isn't wired, provide a stub that
  // throws so retry-unresolved-sensors logs a sensor_failure_logged event.
  const safeConcept2: DispatchDeps["concept2"] = concept2 ?? {
    credentials: { client_id: "", client_secret: "", redirect_uri: "" },
    tokens: {
      access_token: "",
      refresh_token: "",
      expires_at: 0,
      token_type: "Bearer",
      scope: "",
    },
  };
  const dispatch = makeInProcessDispatch({
    ledger,
    adapter,
    sessionId,
    concept2: safeConcept2,
  });

  // Wire the Discord listener to the proof-message handler. This subscription
  // lasts the lifetime of the daemon process; the returned unsubscribe is
  // exposed via cleanup() so SIGTERM tears it down cleanly.
  const unsubscribe = subscribeMessages({
    adapter,
    db,
    handler: async (match): Promise<void> => {
      try {
        await handleProofMessage({
          sessionStore: ledger.sessionStore,
          adapter,
          sessionId,
          run: match.run,
          message: match.message,
          channelName: match.channelName,
          now: Date.now(),
          concept2:
            concept2 !== null
              ? {
                  credentials: concept2.credentials,
                  tokens: concept2.tokens,
                  onTokensRefreshed: (newTokens) => {
                    concept2!.tokens = newTokens;
                    saveConcept2Tokens(newTokens);
                  },
                }
              : null,
          visionDispatchImpl: dispatchClaudeForCheckin,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logErr(`handleProofMessage exception: ${msg}`);
      }
    },
  });
  logInfo(`discord listener subscribed`);

  const cleanup = async (): Promise<void> => {
    unsubscribe();
    await adapter.client.destroy();
    ledger.close();
  };

  return { ledger, dispatch, sessionId, cleanup };
}
