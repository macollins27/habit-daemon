/**
 * createHabit — orchestration verb that inserts a new row in `habits`,
 * validating the input via Zod and the cadence via the cron parser.
 *
 * Audit trail: every successful create appends a single `habit_created` event
 * to `session_events` under the `habit-mgmt` session id (trustLevel L1 —
 * artifact-backed by the input payload itself). The insert and the event are
 * written inside one better-sqlite3 transaction so a duplicate-slug failure
 * mid-flow leaves neither row behind.
 *
 * API → DB field mapping (see src/api/schemas.ts for the public-name
 * rationale):
 *
 *   API field name     → habits column          (this orchestrator translates)
 *   -----------------  --------------------------------------------------
 *   slug               → id  (prefixed with "habit_" so the API can
 *                              distinguish user-created rows from the
 *                              seed-time rows like "morning-row")
 *   display_name       → name
 *   cadence            → cron_expr
 *   proof_config       → proof_config_json  (object → JSON.stringify)
 *   why_stakes         → why_stakes_json    (object → JSON.stringify)
 *
 * The 001_habits.sql schema uses `id` as the primary key and has no separate
 * `slug` column — seed habits already use slug-like ids ("morning-row"). To
 * keep one identifier convention across seed + user-created rows AND give the
 * web UI a stable visual prefix for newly-created habits, we generate
 * `id = "habit_" + slug`. Uniqueness on `slug` therefore reduces to a
 * uniqueness check on the derived id (id is PRIMARY KEY).
 *
 * `created_at` is stored as INTEGER epoch ms to match
 * `src/db/migrations/001_habits.sql` and the value seeded by
 * `src/db/seed-habits.ts`. The Zod schema is the input-validation boundary;
 * once parsed, all downstream code can rely on the typed shape.
 */

import { HabitCreateInput, type HabitCreate } from "../api/schemas.js";
import { parseCronExpression } from "../daemon/cron-parser.js";
import type { SessionStore } from "../daemon/session-store.js";

export interface CreateHabitOptions {
  readonly sessionStore: SessionStore;
  readonly input: HabitCreate;
}

export interface CreateHabitResult {
  readonly id: string;
}

interface ExistingIdRow {
  readonly id: string;
}

export function createHabit(opts: CreateHabitOptions): CreateHabitResult {
  // Boundary validation — throws ZodError on malformed input before any
  // DB work. Callers always see structured validation failures.
  const input = HabitCreateInput.parse(opts.input);

  // Cadence is validated up-front so an invalid cron rejects atomically
  // without leaving a habits row half-written. The cron-parser already
  // throws with a descriptive message; we wrap it to add the offending value.
  try {
    parseCronExpression(input.cadence);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`invalid cron expression "${input.cadence}": ${msg}`);
  }

  const id = `habit_${input.slug}`;
  const createdAt = Date.now();
  const db = opts.sessionStore.db;

  const insertTx = db.transaction((): void => {
    const existing = db
      .prepare(`SELECT id FROM habits WHERE id = ?`)
      .get(id) as ExistingIdRow | undefined;
    if (existing) {
      throw new Error(`habit slug already exists: ${input.slug}`);
    }

    db.prepare(
      `INSERT INTO habits (
        id, name, domain, cron_expr, why_stakes_json,
        proof_type, proof_config_json, channel_id, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      id,
      input.display_name,
      // `domain` is a legacy NOT NULL column (001_habits.sql) without a
      // default. We seed it with the slug — domain is a coarse routing tag
      // used only by Phase-A seed habits; user-created habits don't need
      // a distinct value, so reusing slug keeps the column populated
      // without inventing a new vocabulary.
      input.slug,
      input.cadence,
      JSON.stringify(input.why_stakes),
      input.proof_type,
      JSON.stringify(input.proof_config),
      input.channel_id,
      createdAt,
    );

    opts.sessionStore.append(
      "habit-mgmt",
      "habit_created",
      { id, input },
      { trustLevel: "L1" },
    );
  });

  insertTx();

  return { id };
}
