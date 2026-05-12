// Task 23: #wins channel auto-post on completion.
//
// `postWin()` is invoked by orchestration verbs when a `habit_runs.status`
// transitions to `completed`. It composes a one-line factual record (no
// qualifiers, no moralizing) per habit type and posts to the #wins channel.
//
// These tests verify:
//   1. `formatWin()` produces the exact string specified in design § 5 for
//      every habit variant in the discriminated union.
//   2. Meter values use the en-US thousand-separator (2,143 not 2143).
//   3. `postWin()` posts when status === 'completed' and is a strict no-op
//      for every other status the design recognises (missed, skipped,
//      unresolved, partial, pending, unresolved_no_data).
//
// The Discord client is mocked using the Task 20/21 clientFactory pattern —
// a structural mock of channels.fetch returning a fake text-based channel
// with a vi.fn() `send`. No real gateway connection.

import { describe, it, expect, vi } from "vitest";
import { type Client } from "discord.js";
import {
  createDiscordAdapter,
  type DiscordAdapter,
  type DiscordChannelIds,
} from "../../src/lib/discord-adapter.js";
import {
  formatWin,
  postWin,
  type Completion,
} from "../../src/orchestrate/wins-poster.js";

function validChannelIds(): DiscordChannelIds {
  return {
    "morning-row": "1000000000000000001",
    strength: "1000000000000000002",
    "wind-down": "1000000000000000003",
    wins: "1000000000000000004",
    "sunday-review": "1000000000000000005",
  };
}

interface MockChannel {
  send: ReturnType<typeof vi.fn>;
  isTextBased: () => boolean;
}

interface MockClient {
  channels: {
    fetch: ReturnType<typeof vi.fn>;
  };
}

interface BuildAdapterResult {
  readonly adapter: DiscordAdapter;
  readonly mockClient: MockClient;
  readonly mockChannel: MockChannel;
}

function buildAdapter(): BuildAdapterResult {
  const mockChannel: MockChannel = {
    send: vi.fn().mockResolvedValue({ id: "wins-msg-1" }),
    isTextBased: () => true,
  };

  const fetch = vi.fn().mockResolvedValue(mockChannel);

  const mockClient: MockClient = {
    channels: { fetch },
  };

  const adapter = createDiscordAdapter({
    botToken: "test-bot-token",
    channelIds: validChannelIds(),
    clientFactory: () => mockClient as unknown as Client,
  });

  return { adapter, mockClient, mockChannel };
}

describe("formatWin()", () => {
  it("formats morning-row with exact string per design § 5", () => {
    const completion: Completion = {
      habit: "morning-row",
      time: "9:42",
      durationMinutes: 12,
      meters: 2143,
    };
    expect(formatWin(completion)).toBe(
      "✓ Morning row · 9:42 · 12 min · 2,143m",
    );
  });

  it("formats strength-mwf with exact string per design § 5", () => {
    const completion: Completion = {
      habit: "strength-mwf",
      time: "Wed 7:08pm",
      liftCount: 4,
    };
    expect(formatWin(completion)).toBe(
      "✓ Strength · Wed 7:08pm · 4 lifts logged",
    );
  });

  it("formats wind-down with exact string per design § 5", () => {
    const completion: Completion = {
      habit: "wind-down",
      stageATime: "22:08",
      garminAsleepTime: "22:55",
    };
    expect(formatWin(completion)).toBe(
      "✓ Wind-down · stage A 22:08 · Garmin asleep 22:55",
    );
  });

  it("uses en-US thousand separator when meters >= 1000", () => {
    const completion: Completion = {
      habit: "morning-row",
      time: "7:00",
      durationMinutes: 30,
      meters: 10000,
    };
    expect(formatWin(completion)).toBe(
      "✓ Morning row · 7:00 · 30 min · 10,000m",
    );
  });

  it("omits the comma separator when meters < 1000", () => {
    const completion: Completion = {
      habit: "morning-row",
      time: "7:00",
      durationMinutes: 2,
      meters: 250,
    };
    expect(formatWin(completion)).toBe(
      "✓ Morning row · 7:00 · 2 min · 250m",
    );
  });

  it("includes both ✓ (U+2713) and middle-dot (U+00B7) characters in output", () => {
    const completion: Completion = {
      habit: "morning-row",
      time: "9:42",
      durationMinutes: 12,
      meters: 2143,
    };
    const result = formatWin(completion);
    expect(result).toContain("✓");
    expect(result).toContain("·");
  });
});

describe("postWin()", () => {
  it("posts to channel='wins' with exact formatted content when status='completed'", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();
    const completion: Completion = {
      habit: "morning-row",
      time: "9:42",
      durationMinutes: 12,
      meters: 2143,
    };

    const result = await postWin({
      adapter,
      status: "completed",
      completion,
    });

    expect(mockClient.channels.fetch).toHaveBeenCalledTimes(1);
    expect(mockClient.channels.fetch).toHaveBeenCalledWith(
      "1000000000000000004",
    );
    expect(mockChannel.send).toHaveBeenCalledTimes(1);
    const sendArg = mockChannel.send.mock.calls[0]![0];
    expect(sendArg.content).toBe(
      "✓ Morning row · 9:42 · 12 min · 2,143m",
    );
    expect(result).toEqual({ posted: true, messageId: "wins-msg-1" });
  });

  it("posts strength completion to #wins", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();

    const result = await postWin({
      adapter,
      status: "completed",
      completion: { habit: "strength-mwf", time: "Wed 7:08pm", liftCount: 4 },
    });

    expect(mockClient.channels.fetch).toHaveBeenCalledWith(
      "1000000000000000004",
    );
    const sendArg = mockChannel.send.mock.calls[0]![0];
    expect(sendArg.content).toBe(
      "✓ Strength · Wed 7:08pm · 4 lifts logged",
    );
    expect(result.posted).toBe(true);
    expect(result.messageId).toBe("wins-msg-1");
  });

  it("posts wind-down completion to #wins", async () => {
    const { adapter, mockChannel } = buildAdapter();

    await postWin({
      adapter,
      status: "completed",
      completion: {
        habit: "wind-down",
        stageATime: "22:08",
        garminAsleepTime: "22:55",
      },
    });

    const sendArg = mockChannel.send.mock.calls[0]![0];
    expect(sendArg.content).toBe(
      "✓ Wind-down · stage A 22:08 · Garmin asleep 22:55",
    );
  });

  it("is a no-op when status='missed' — does not call postToChannel", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();

    const result = await postWin({
      adapter,
      status: "missed",
      completion: {
        habit: "morning-row",
        time: "9:42",
        durationMinutes: 12,
        meters: 2143,
      },
    });

    expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    expect(mockChannel.send).not.toHaveBeenCalled();
    expect(result).toEqual({ posted: false });
  });

  it("is a no-op when status='skipped'", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();

    const result = await postWin({
      adapter,
      status: "skipped",
      completion: { habit: "strength-mwf", time: "Wed 7:08pm", liftCount: 4 },
    });

    expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    expect(mockChannel.send).not.toHaveBeenCalled();
    expect(result).toEqual({ posted: false });
  });

  it("is a no-op when status='unresolved'", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();

    const result = await postWin({
      adapter,
      status: "unresolved",
      completion: {
        habit: "wind-down",
        stageATime: "22:08",
        garminAsleepTime: "22:55",
      },
    });

    expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    expect(mockChannel.send).not.toHaveBeenCalled();
    expect(result).toEqual({ posted: false });
  });

  it("is a no-op when status='partial'", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();

    const result = await postWin({
      adapter,
      status: "partial",
      completion: {
        habit: "morning-row",
        time: "9:42",
        durationMinutes: 12,
        meters: 2143,
      },
    });

    expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    expect(mockChannel.send).not.toHaveBeenCalled();
    expect(result).toEqual({ posted: false });
  });

  it("is a no-op when status='pending'", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();

    const result = await postWin({
      adapter,
      status: "pending",
      completion: {
        habit: "morning-row",
        time: "9:42",
        durationMinutes: 12,
        meters: 2143,
      },
    });

    expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    expect(mockChannel.send).not.toHaveBeenCalled();
    expect(result).toEqual({ posted: false });
  });

  it("is a no-op when status='unresolved_no_data'", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();

    const result = await postWin({
      adapter,
      status: "unresolved_no_data",
      completion: {
        habit: "wind-down",
        stageATime: "22:08",
        garminAsleepTime: "22:55",
      },
    });

    expect(mockClient.channels.fetch).not.toHaveBeenCalled();
    expect(mockChannel.send).not.toHaveBeenCalled();
    expect(result).toEqual({ posted: false });
  });
});
