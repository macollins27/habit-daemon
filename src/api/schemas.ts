/**
 * Shared Zod schemas for the chat / web-UI habit management API.
 *
 * Naming bridge — these field names are the **public API contract** used by
 * the chat slash-commands and the web UI's habit form. They intentionally
 * differ from the underlying SQLite column names:
 *
 *   API field name     → habits column          (mapping done in orchestrators)
 *   -----------------  --------------------------------------------------
 *   display_name       → name             TEXT
 *   cadence            → cron_expr        TEXT
 *   proof_config       → proof_config_json TEXT (JSON-serialized object)
 *   why_stakes         → why_stakes_json   TEXT (JSON-serialized object)
 *   channel_id         → channel_id        TEXT
 *   proof_type         → proof_type        TEXT
 *
 * `ProofTypeEnum` mirrors the production values seeded by `seedHabits()` in
 * `src/db/seed-habits.ts` and routed by `src/orchestrate/verify-proof.ts`.
 * Adding a new value here means adding a sub-verb in verify-proof; keep the
 * two in sync.
 *
 * References:
 *   - src/db/migrations/001_habits.sql (habits column types)
 *   - src/db/seed-habits.ts (proof_type values currently in use)
 *   - src/orchestrate/verify-proof.ts (router over proof_type)
 */

import { z } from "zod";

export const ProofTypeEnum = z.enum([
  "concept2_api+photo_fallback",
  "training_log_photo",
  "typed_msg+garmin_sleep",
  "alignment_text",
]);

export type ProofType = z.infer<typeof ProofTypeEnum>;

export const HabitCreateInput = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric or dashes"),
  display_name: z.string().min(1).max(120),
  cadence: z.string().min(1),
  proof_type: ProofTypeEnum,
  proof_config: z.record(z.string(), z.unknown()),
  why_stakes: z.record(z.string(), z.unknown()),
  channel_id: z.string().min(1),
});

export type HabitCreate = z.infer<typeof HabitCreateInput>;

export const HabitPatchInput = HabitCreateInput.partial();

export type HabitPatch = z.infer<typeof HabitPatchInput>;

/**
 * Maps public API field names (HabitCreate / HabitPatch keys) to the actual
 * `habits` table column names. Centralised here so that `createHabit`,
 * `updateHabit`, and any future write path cannot drift from each other.
 *
 * - `slug` → `id` is the create-only mapping: `createHabit` writes
 *   `id = "habit_" + slug`. `updateHabit` never sees `slug` in a patch
 *   (the API contract does not allow renaming an id), so the `slug → id`
 *   entry is unused on the update path; it is included here so the table
 *   is canonical for the full HabitCreate keyspace.
 * - JSON-typed columns (see `HABIT_JSON_COLUMNS` below) require
 *   `JSON.stringify` on the value before binding; scalar columns bind
 *   directly.
 */
export const HABIT_FIELD_TO_COLUMN: Readonly<Record<keyof HabitCreate, string>> =
  {
    slug: "id",
    display_name: "name",
    cadence: "cron_expr",
    proof_type: "proof_type",
    proof_config: "proof_config_json",
    why_stakes: "why_stakes_json",
    channel_id: "channel_id",
  };

/**
 * Subset of HabitCreate keys whose values are JSON objects in the API
 * contract and TEXT-encoded JSON in the database (`*_json` columns).
 * Callers must `JSON.stringify` the raw value before binding.
 */
export const HABIT_JSON_COLUMNS: ReadonlySet<keyof HabitCreate> = new Set([
  "proof_config",
  "why_stakes",
]);
