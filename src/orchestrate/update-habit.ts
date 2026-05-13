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

import { HabitPatchInput, type HabitPatch } from "../api/schemas.js";
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

// API field name → habits column name. Object-valued fields are JSON-encoded
// into a `_json` column; scalar fields go to the column whose name appears
// in the value here. Anything not in this map is treated as a passthrough
// (column name equals API field name).
const FIELD_TO_COLUMN: ReadonlyMap<keyof HabitPatch, string> = new Map([
  ["display_name", "name"],
  ["cadence", "cron_expr"],
  ["proof_config", "proof_config_json"],
  ["why_stakes", "why_stakes_json"],
  ["proof_type", "proof_type"],
  ["channel_id", "channel_id"],
]);

// API fields whose value is an object and must be JSON.stringify'd before
// going to SQLite. Scalar fields bypass this.
const JSON_FIELDS: ReadonlySet<keyof HabitPatch> = new Set([
  "proof_config",
  "why_stakes",
]);

function isJsonField(key: keyof HabitPatch): boolean {
  return JSON_FIELDS.has(key);
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
      const column = FIELD_TO_COLUMN.get(key);
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
