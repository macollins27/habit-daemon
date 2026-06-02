/**
 * Centralised serialization of `habits` rows into the public HTTP API shape.
 *
 * Every read endpoint that returns a habit MUST funnel its rows through
 * `serializeHabit` so the API contract cannot drift from the DB schema.
 *
 * Mapping rules:
 *   - DB column names from HABIT_FIELD_TO_COLUMN are translated back to
 *     their public API field names. (`name` → `display_name`,
 *     `cron_expr` → `cadence`, etc.)
 *   - JSON-typed columns (`proof_config_json`, `why_stakes_json`) are
 *     parsed back to objects. We do not validate them against the Zod
 *     schema on read — they were validated on write, and a stricter
 *     read-side guard would surface as a 500 if a seed habit's JSON
 *     didn't fit the current schema. Instead we trust the column.
 *   - Extra columns the SELECT may join in (e.g. JOIN aliases prefixed
 *     with `_today_run_*`) are dropped: only the public-API fields and
 *     the four canonical metadata fields (`id`, `created_at`,
 *     `archived_at`, `active`) make it into the response.
 *
 * Boundary discipline: this helper accepts an unknown-keyed row (the raw
 * `better-sqlite3` row) and narrows each field with `unknown` -> typed
 * casts at the boundary. We deliberately avoid `as any` so the
 * type-checker still validates downstream usage.
 */

import { HABIT_FIELD_TO_COLUMN, HABIT_JSON_COLUMNS, type HabitCreate } from "./schemas.js";

export interface HabitResponse extends HabitCreate {
  readonly id: string;
  readonly created_at: number; // epoch ms (stored as INTEGER in habits.created_at)
  readonly archived_at: string | null; // ISO timestamp string (or null when active)
  readonly active: 0 | 1;
}

/**
 * Build the reverse mapping (DB column → API field name) once at module
 * load. This is the inverse of HABIT_FIELD_TO_COLUMN.
 */
const COLUMN_TO_FIELD: Readonly<Record<string, keyof HabitCreate>> = (() => {
  const out: Record<string, keyof HabitCreate> = {};
  for (const [field, column] of Object.entries(HABIT_FIELD_TO_COLUMN) as ReadonlyArray<
    [keyof HabitCreate, string]
  >) {
    out[column] = field;
  }
  return out;
})();

/**
 * `slug` is a write-only field: callers POST a slug, the orchestrator
 * derives `id = "habit_" + slug`, and the DB stores only `id`. The
 * response therefore omits `slug` and exposes `id` instead. We skip the
 * `id`-column branch in the serializer so we don't surface it as
 * `response.slug = "habit_evening-walk"` (which would be wrong).
 */
const ID_COLUMN = HABIT_FIELD_TO_COLUMN.slug; // "id"

interface HabitsBaseRow {
  readonly id: string;
  readonly created_at: number;
  readonly archived_at: string | null;
  readonly active: number;
}

function parseJsonColumn(value: unknown, column: string): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error(`serializeHabit: expected JSON string in ${column}, got ${typeof value}`);
  }
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`serializeHabit: JSON column ${column} did not parse to an object`);
  }
  return parsed as Record<string, unknown>;
}

export function serializeHabit(row: Record<string, unknown>): HabitResponse {
  const base = row as unknown as HabitsBaseRow;
  if (typeof base.id !== "string") {
    throw new Error("serializeHabit: row.id missing or not a string");
  }
  if (typeof base.created_at !== "number") {
    throw new Error("serializeHabit: row.created_at missing or not a number");
  }
  if (base.active !== 0 && base.active !== 1) {
    throw new Error(`serializeHabit: row.active must be 0 or 1, got ${String(base.active)}`);
  }

  // Build the public-shape body by walking HABIT_FIELD_TO_COLUMN in a
  // single pass. Skip the `slug`→`id` entry (handled by `id` below) and
  // parse JSON columns where required.
  const out: Record<string, unknown> = {
    id: base.id,
    created_at: base.created_at,
    archived_at: base.archived_at ?? null,
    active: base.active,
  };
  for (const [column, field] of Object.entries(COLUMN_TO_FIELD) as ReadonlyArray<
    [string, keyof HabitCreate]
  >) {
    if (column === ID_COLUMN) {
      // slug is not echoed in responses — `id` carries the durable identity.
      continue;
    }
    const raw = row[column];
    if (HABIT_JSON_COLUMNS.has(field)) {
      out[field] = parseJsonColumn(raw, column);
    } else {
      out[field] = raw;
    }
  }
  return out as unknown as HabitResponse;
}
