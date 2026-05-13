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
