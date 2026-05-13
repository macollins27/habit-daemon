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

import {
  HabitCreateInput,
  HABIT_FIELD_TO_COLUMN,
  HABIT_JSON_COLUMNS,
  type HabitCreate,
} from "../api/schemas.js";
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

// The order in which HabitCreate keys are written to the `habits` row.
// Drives both the INSERT column list and the parameter ordering below,
// keeping them locked-in-step. Every key from HABIT_FIELD_TO_COLUMN is
// covered by this list (assertion at module load below).
const HABIT_INSERT_FIELDS: readonly (keyof HabitCreate)[] = [
  "slug",
  "display_name",
  "cadence",
  "why_stakes",
  "proof_type",
  "proof_config",
  "channel_id",
];

// Boot-time guard against drift between the shared field/column map and
// the INSERT field list. If HABIT_FIELD_TO_COLUMN grows a new key, this
// throws at module load so the bug surfaces in the first test run.
const _expectedKeys = Object.keys(HABIT_FIELD_TO_COLUMN).sort().join(",");
const _insertKeys = [...HABIT_INSERT_FIELDS].sort().join(",");
if (_expectedKeys !== _insertKeys) {
  throw new Error(
    `create-habit: HABIT_INSERT_FIELDS drift from HABIT_FIELD_TO_COLUMN ` +
      `(expected=${_expectedKeys}; got=${_insertKeys})`,
  );
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

  // Build the dynamic-column portion of the INSERT from the shared
  // HABIT_FIELD_TO_COLUMN map so the column list cannot drift from the
  // canonical mapping. Two columns are hard-coded outside this loop:
  //   - `domain` (NOT NULL legacy routing tag — set to slug; see comment
  //     below)
  //   - `active` (always 1 for newly-created habits)
  //   - `created_at` (epoch ms at insert time)
  const dynamicColumns: string[] = [];
  const dynamicValues: unknown[] = [];
  for (const field of HABIT_INSERT_FIELDS) {
    dynamicColumns.push(HABIT_FIELD_TO_COLUMN[field]);
    if (field === "slug") {
      // The API's `slug` becomes the DB row's `id`, prefixed with `habit_`
      // so user-created rows are visually distinguishable from seeded ones
      // (id is the primary key — uniqueness on slug reduces to uniqueness
      // on id).
      dynamicValues.push(id);
    } else if (HABIT_JSON_COLUMNS.has(field)) {
      dynamicValues.push(JSON.stringify(input[field]));
    } else {
      dynamicValues.push(input[field]);
    }
  }

  const columnList = [...dynamicColumns, "domain", "active", "created_at"].join(
    ", ",
  );
  const placeholderList =
    dynamicValues.map(() => "?").join(", ") + ", ?, 1, ?";

  const insertTx = db.transaction((): void => {
    const existing = db
      .prepare(`SELECT id FROM habits WHERE id = ?`)
      .get(id) as ExistingIdRow | undefined;
    if (existing) {
      throw new Error(`habit slug already exists: ${input.slug}`);
    }

    db.prepare(`INSERT INTO habits (${columnList}) VALUES (${placeholderList})`).run(
      ...dynamicValues,
      // `domain` is a legacy NOT NULL column (001_habits.sql) without a
      // default. We seed it with the slug — domain is a coarse routing tag
      // used only by Phase-A seed habits; user-created habits don't need
      // a distinct value, so reusing slug keeps the column populated
      // without inventing a new vocabulary.
      input.slug,
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
