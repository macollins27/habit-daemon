/**
 * updateHabit — partial-patch a single habit row, with cron re-validation when
 * `cadence` changes, and an audit event recording exactly which fields moved.
 *
 * Patch semantics:
 *   - The patch must be non-empty (at least one field).
 *   - Cadence (when present) is re-validated via the cron parser; an invalid
 *     value rejects atomically before any UPDATE runs.
 *   - Object-valued fields (`proof_config`, `why_stakes`) are JSON-serialized
 *     into their corresponding `_json` columns; scalar fields update their
 *     columns directly. The API→DB name mapping is the same as createHabit.
 *   - `changed_fields` in the audit event preserves insertion order of the
 *     patch keys (the order the caller supplied), so reviewers can see the
 *     intent of the edit.
 *
 * Transactional: UPDATE + append-event happen inside one better-sqlite3
 * transaction so a CHECK failure or audit-event failure rolls back the row.
 */

import {
  HabitPatchInput,
  HABIT_FIELD_TO_COLUMN,
  HABIT_JSON_COLUMNS,
  type HabitCreate,
  type HabitPatch,
} from "../api/schemas.js";
import { parseCronExpression } from "../daemon/cron-parser.js";
import type { SessionStore } from "../daemon/session-store.js";

export interface UpdateHabitOptions {
  readonly sessionStore: SessionStore;
  readonly id: string;
  readonly patch: HabitPatch;
}

interface HabitExistsRow {
  readonly id: string;
}

// The API → DB column mapping and JSON-column set are imported from
// `src/api/schemas.ts` so `createHabit`, `updateHabit`, and any future write
// path agree on one source of truth. `slug` appears in HABIT_FIELD_TO_COLUMN
// (mapping to `id`) but is rejected on the update path below because slugs
// are immutable — the create-only key is left in the shared table so the
// constant is canonical for the full HabitCreate keyspace.
function isJsonField(key: keyof HabitPatch): boolean {
  return HABIT_JSON_COLUMNS.has(key);
}

export function updateHabit(opts: UpdateHabitOptions): void {
  // Boundary validation — throws ZodError on malformed input before any
  // DB work. .partial() makes every field optional but still rejects
  // unknown types / wrong types on the fields that ARE present.
  const patch = HabitPatchInput.parse(opts.patch);

  // We can't trust `Object.keys` to return the canonical set — Zod's
  // `.partial()` does not strip extra keys (default is "strip" via parse(),
  // which DOES strip; but TypeScript's typing of the result still lists
  // every key as optional). After parse, every present key is a valid
  // HabitPatch field.
  const changedFields = Object.keys(patch) as Array<keyof HabitPatch>;
  if (changedFields.length === 0) {
    throw new Error("patch is empty: provide at least one field");
  }

  // Re-validate cadence up-front. If invalid, throw before touching the row.
  if (patch.cadence !== undefined) {
    try {
      parseCronExpression(patch.cadence);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`invalid cron expression "${patch.cadence}": ${msg}`);
    }
  }

  const db = opts.sessionStore.db;

  const tx = db.transaction((): void => {
    const existing = db
      .prepare(`SELECT id FROM habits WHERE id = ?`)
      .get(opts.id) as HabitExistsRow | undefined;
    if (!existing) {
      throw new Error(`unknown habit id: ${opts.id}`);
    }

    const setters: string[] = [];
    const params: unknown[] = [];
    for (const key of changedFields) {
      // `slug` is a HabitCreate-only key (immutable on update). Reject loud
      // rather than silently translating to UPDATE habits SET id = ?.
      if (key === "slug") {
        throw new Error("slug is immutable; cannot be updated");
      }
      const column = HABIT_FIELD_TO_COLUMN[key as keyof HabitCreate];
      if (column === undefined) {
        // Should be unreachable because Zod stripped unknown keys, but
        // fail loudly rather than silently ignoring.
        throw new Error(`unknown patch field: ${String(key)}`);
      }
      const rawValue = patch[key];
      const dbValue = isJsonField(key) ? JSON.stringify(rawValue) : rawValue;
      setters.push(`${column} = ?`);
      params.push(dbValue);
    }
    params.push(opts.id);

    db.prepare(`UPDATE habits SET ${setters.join(", ")} WHERE id = ?`).run(
      ...(params as readonly unknown[]),
    );

    opts.sessionStore.append(
      "habit-mgmt",
      "habit_updated",
      { id: opts.id, changed_fields: changedFields, patch },
      { trustLevel: "L1" },
    );
  });

  tx();
}
