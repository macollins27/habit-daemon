// Task 24: tests for buildHabitCheckinPrompt — the shared prompt-builder
// used by every habit-checkin level template (L1 here, L2-L5 in later tasks).
//
// The builder is a pure string composer:
//   - Takes a HabitContext (parsed habit row + parsed proof_config/why_stakes
//     JSON), a RunContext (habit_run row fields), a list of recent events,
//     and a LevelTemplate (voice rules + output schema for that level).
//   - Returns the system prompt that will be passed to `claude -p`.
//
// The single behavioural switch is `RunContext.proof_rejection_callout_due`:
//   - When 0: prompt MUST NOT contain the callout instruction.
//   - When 1: prompt MUST contain the callout instruction with the habit's
//     `proof_config.vision_subject` interpolated into the example phrase.
//
// These tests verify the builder in isolation — the actual flag-reset and
// dispatch flow is covered by habit-checkin-l1.test.ts.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 24
//   - src/lib/prompt-builder.ts
//   - src/lib/prompt-templates/level-1.ts

import { describe, it, expect } from "vitest";
import {
  buildHabitCheckinPrompt,
  type HabitContext,
  type RunContext,
  type LevelTemplate,
} from "../../src/lib/prompt-builder.js";
import type { SessionEventRow } from "../../src/daemon/session-store.js";
import { LEVEL_1_TEMPLATE } from "../../src/lib/prompt-templates/level-1.js";

function strengthHabit(): HabitContext {
  return {
    id: "strength-mwf",
    name: "Strength M/W/F",
    domain: "strength",
    cron_expr: "20 18 * * 1,3,5",
    proof_type: "training_log_photo",
    proof_config: {
      min_log_entries: 3,
      vision_subject: "training_log",
    },
    why_stakes: {},
  };
}

function morningRowHabit(): HabitContext {
  return {
    id: "morning-row",
    name: "Morning row",
    domain: "row",
    cron_expr: "5 9 * * *",
    proof_type: "concept2_api+photo_fallback",
    proof_config: {
      min_minutes: 10,
      vision_subject: "pm5_screen",
    },
    why_stakes: {},
  };
}

function runContext(opts: { calloutDue?: 0 | 1 } = {}): RunContext {
  return {
    id: "run-test-0001",
    fire_date: "2026-05-12",
    current_level: 1,
    status: "pending",
    fired_at: Date.parse("2026-05-12T09:05:00Z"),
    proof_rejection_callout_due: opts.calloutDue ?? 0,
  };
}

function noEvents(): readonly SessionEventRow[] {
  return [];
}

function sampleEvent(overrides: Partial<SessionEventRow> = {}): SessionEventRow {
  return {
    id: 1,
    sessionId: "session-test",
    seq: 0,
    eventJson: JSON.stringify({
      habitId: "morning-row",
      runId: "run-test-0001",
      note: "sample-note-payload",
    }),
    prevHash: null,
    hash: "abc",
    trustLevel: "L1",
    writtenIso: "2026-05-12T09:00:00.000Z",
    eventType: "habit_prompt_sent",
    ...overrides,
  };
}

describe("buildHabitCheckinPrompt()", () => {
  it("returns a non-empty string with the level name in the header", () => {
    const prompt = buildHabitCheckinPrompt({
      habit: morningRowHabit(),
      run: runContext(),
      currentLevel: 1,
      recentEvents: noEvents(),
      levelTemplate: LEVEL_1_TEMPLATE,
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("L1");
  });

  it("includes habit name, domain, cron_expr, and proof_type in the prompt body", () => {
    const prompt = buildHabitCheckinPrompt({
      habit: morningRowHabit(),
      run: runContext(),
      currentLevel: 1,
      recentEvents: noEvents(),
      levelTemplate: LEVEL_1_TEMPLATE,
    });
    expect(prompt).toContain("Morning row");
    expect(prompt).toContain("row");
    expect(prompt).toContain("5 9 * * *");
    expect(prompt).toContain("concept2_api+photo_fallback");
  });

  it("includes the level template's voice rules verbatim", () => {
    const customTemplate: LevelTemplate = {
      levelName: "L1",
      voiceRules: "DISTINCT_VOICE_RULES_MARKER_xyz123",
      outputSchema: '{"type":"object"}',
    };
    const prompt = buildHabitCheckinPrompt({
      habit: morningRowHabit(),
      run: runContext(),
      currentLevel: 1,
      recentEvents: noEvents(),
      levelTemplate: customTemplate,
    });
    expect(prompt).toContain("DISTINCT_VOICE_RULES_MARKER_xyz123");
  });

  it("includes the output schema as a string in the prompt", () => {
    const customTemplate: LevelTemplate = {
      levelName: "L1",
      voiceRules: "rules",
      outputSchema: '{"type":"object","properties":{"MARKER_SCHEMA_FIELD":{}}}',
    };
    const prompt = buildHabitCheckinPrompt({
      habit: morningRowHabit(),
      run: runContext(),
      currentLevel: 1,
      recentEvents: noEvents(),
      levelTemplate: customTemplate,
    });
    expect(prompt).toContain("MARKER_SCHEMA_FIELD");
  });

  it("does NOT contain the rejection callout when proof_rejection_callout_due=0", () => {
    const prompt = buildHabitCheckinPrompt({
      habit: strengthHabit(),
      run: runContext({ calloutDue: 0 }),
      currentLevel: 1,
      recentEvents: noEvents(),
      levelTemplate: LEVEL_1_TEMPLATE,
    });
    expect(prompt).not.toContain("CALLOUT:");
    expect(prompt).not.toContain("three photos");
  });

  it("DOES contain the rejection callout when proof_rejection_callout_due=1", () => {
    const prompt = buildHabitCheckinPrompt({
      habit: strengthHabit(),
      run: runContext({ calloutDue: 1 }),
      currentLevel: 1,
      recentEvents: noEvents(),
      levelTemplate: LEVEL_1_TEMPLATE,
    });
    expect(prompt).toContain("CALLOUT:");
    expect(prompt).toContain("3+ photo proof attempts rejected");
  });

  it("interpolates proof_config.vision_subject into the callout instruction (training_log)", () => {
    const prompt = buildHabitCheckinPrompt({
      habit: strengthHabit(),
      run: runContext({ calloutDue: 1 }),
      currentLevel: 1,
      recentEvents: noEvents(),
      levelTemplate: LEVEL_1_TEMPLATE,
    });
    expect(prompt).toContain("training_log");
  });

  it("interpolates proof_config.vision_subject into the callout instruction (pm5_screen)", () => {
    const prompt = buildHabitCheckinPrompt({
      habit: morningRowHabit(),
      run: runContext({ calloutDue: 1 }),
      currentLevel: 1,
      recentEvents: noEvents(),
      levelTemplate: LEVEL_1_TEMPLATE,
    });
    expect(prompt).toContain("pm5_screen");
  });

  it("includes recent-event payload content in the prompt body", () => {
    const events = [
      sampleEvent({
        id: 1,
        eventJson: JSON.stringify({
          habitId: "morning-row",
          runId: "run-test-0001",
          note: "RECENT_EVENT_MARKER_SENTINEL",
        }),
      }),
    ];
    const prompt = buildHabitCheckinPrompt({
      habit: morningRowHabit(),
      run: runContext(),
      currentLevel: 1,
      recentEvents: events,
      levelTemplate: LEVEL_1_TEMPLATE,
    });
    expect(prompt).toContain("RECENT_EVENT_MARKER_SENTINEL");
  });
});
