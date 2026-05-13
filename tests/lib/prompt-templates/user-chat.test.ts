// Phase 4 / Task 4.1: tests for buildUserChatSystemPrompt.
//
// The builder is a pure string composer; tests pin the load-bearing contract
// the rest of Phase 4 relies on:
//   - channelName presence is reflected in the prompt
//   - the JSON context block round-trips the input
//   - the no-action / read-only instruction is present
//   - `channelName: null` is handled gracefully (no string concat with null)

import { describe, it, expect } from "vitest";
import {
  buildUserChatSystemPrompt,
  type ChatContext,
} from "../../../src/lib/prompt-templates/user-chat.js";

function emptyCtx(overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    nowIso: "2026-05-13T10:00:00.000Z",
    channelName: null,
    habits: [],
    todayRuns: [],
    recentRuns30d: [],
    recentEvents: [],
    recentMissReasons: [],
    sensorRecency: { concept2_last_iso: null, garmin_last_iso: null },
    recentChat: [],
    ...overrides,
  };
}

describe("buildUserChatSystemPrompt", () => {
  it("embeds the channel name when one is provided", () => {
    const prompt = buildUserChatSystemPrompt(
      emptyCtx({ channelName: "morning-row" }),
    );
    expect(prompt).toMatch(/#morning-row/);
    expect(prompt).toMatch(/Bias your answer toward the morning-row habit/);
  });

  it("falls back to a general framing when channelName is null", () => {
    const prompt = buildUserChatSystemPrompt(emptyCtx({ channelName: null }));
    expect(prompt).toMatch(/not tied to a specific active habit/);
    // Should NOT contain a stray "null" channel mention.
    expect(prompt).not.toMatch(/#null/);
  });

  it("embeds the full ChatContext as a JSON code block", () => {
    const ctx = emptyCtx({
      habits: [
        {
          id: "morning-row",
          name: "Morning Row",
          domain: "row",
          proof_type: "concept2_api+photo_fallback",
          archived_at: null,
        },
      ],
      todayRuns: [
        {
          habit_id: "morning-row",
          fire_date: "2026-05-13",
          status: "pending",
          current_level: 2,
          completed_at: null,
        },
      ],
    });
    const prompt = buildUserChatSystemPrompt(ctx);
    expect(prompt).toMatch(/```json/);
    // The embedded JSON should contain a literal field we know is in the ctx.
    expect(prompt).toContain('"id": "morning-row"');
    expect(prompt).toContain('"status": "pending"');
    expect(prompt).toContain('"current_level": 2');
  });

  it("includes the read-only / no-action instruction so the model declines edits", () => {
    const prompt = buildUserChatSystemPrompt(emptyCtx());
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/CANNOT mark a run complete/);
    expect(prompt).toMatch(/edits happen in the web UI/);
  });

  it("includes the ~200 word reply-shape constraint and the no-emoji rule", () => {
    const prompt = buildUserChatSystemPrompt(emptyCtx());
    expect(prompt).toMatch(/200 words MAXIMUM/);
    expect(prompt).toMatch(/No emoji decoration/);
  });
});
