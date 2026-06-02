// Phase 4 / Task 4.1: tests for buildUserChatSystemPrompt.
//
// The builder is a pure string composer; tests pin the load-bearing contract
// the rest of Phase 4 relies on:
//   - channelName presence is reflected in the prompt
//   - the JSON context block round-trips the input
//   - the prompt frames the bot as Max's accountability partner (not a Q&A bot)
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
  it("frames the shared habits channel (single-channel mode) regardless of which channelName was passed", () => {
    // Single-channel mode: all three active habits share one channel, so the
    // representative channelName the listener passes is somewhat arbitrary.
    // The prompt must not bias the bot toward any specific habit based on it.
    const prompt = buildUserChatSystemPrompt(
      emptyCtx({ channelName: "morning-row" }),
    );
    expect(prompt).toMatch(/shared habits channel/i);
    // Must NOT bias toward the passed channelName.
    expect(prompt).not.toMatch(/Lean toward that habit/i);
    // Should NOT render the channelName as a #-hash bias.
    expect(prompt).not.toMatch(/#morning-row/);
  });

  it("uses the same shared-channel framing when channelName is null", () => {
    const prompt = buildUserChatSystemPrompt(emptyCtx({ channelName: null }));
    expect(prompt).toMatch(/shared habits channel/i);
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

  it("frames the bot as Max's accountability partner, not a Q&A assistant", () => {
    const prompt = buildUserChatSystemPrompt(emptyCtx());
    // The bot must understand it's a coach, not customer support.
    expect(prompt).toMatch(/accountability partner/i);
    // The "why this exists" framing must be present so the model knows what
    // Max actually built this for.
    expect(prompt).toMatch(/rationaliz/i);
    // The bot is told to be proactive, not just answer questions.
    expect(prompt).toMatch(/PROACTIVE/);
    // Pushback on rationalization is explicit.
    expect(prompt).toMatch(/push back/i);
  });

  it("names the technical read-only constraint but frames it as a database limit, not a conversational one", () => {
    const prompt = buildUserChatSystemPrompt(emptyCtx());
    // The bot still must understand it can't write to the DB.
    expect(prompt).toMatch(/can't write to the database/i);
    // But it must be framed as a TECHNICAL limit, not a refusal to engage.
    expect(prompt).toMatch(/TECHNICAL limit/);
    expect(prompt).toMatch(/not a conversational one/i);
  });

  it("includes anti-corporate-tone instructions", () => {
    const prompt = buildUserChatSystemPrompt(emptyCtx());
    expect(prompt).toMatch(/No corporate help-desk voice/);
    expect(prompt).toMatch(/great question/);
    expect(prompt).toMatch(/profanity/i);
  });
});
