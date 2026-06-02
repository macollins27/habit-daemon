// Task 21: Discord webhook poster (outgoing).
//
// `postToChannel()` is the outbound side of the Discord adapter — it takes a
// `ChannelName` (one of the five registered destinations), resolves it to a
// Discord channel ID via the adapter's registry, fetches the channel through
// the discord.js Client, and posts a message (optionally with attachments).
//
// These tests use a structural mock for the discord.js Client (injected via
// the `clientFactory` from Task 20) so we never open a real gateway
// connection. The mock exposes a `channels.fetch` vi.fn() returning a mock
// TextBasedChannel whose `send` is also a vi.fn() returning a canned Message.
//
// Coverage:
//
//   1. Happy path, text-only: correct channelId lookup, correct send payload.
//   2. Happy path with one attachment: AttachmentBuilder wraps the Buffer
//      with `name` and `description`.
//   3. Return shape: {messageId, channelId, postedAt} populated from the
//      mock's Message id, the registry, and Date.now() (pinned via fake timers).
//   4. Unknown channel name (cast around the type system): runtime guard fires.
//   5. channels.fetch returns null: descriptive throw.
//   6. channels.fetch returns a non-text channel: descriptive throw.
//   7. channel.send rejects (e.g. rate-limited): error propagates, not swallowed.
//   8. Multiple attachments: every spec lands in `files` in order.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AttachmentBuilder, type Client } from "discord.js";
import {
  createDiscordAdapter,
  postToChannel,
  type DiscordAdapter,
  type DiscordChannelIds,
} from "../../src/lib/discord-adapter.js";

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

interface BuildAdapterArgs {
  readonly mockChannel?: MockChannel | null;
  readonly fetchImpl?: ReturnType<typeof vi.fn>;
}

interface BuildAdapterResult {
  readonly adapter: DiscordAdapter;
  readonly mockClient: MockClient;
  readonly mockChannel: MockChannel | null;
}

function buildAdapter(args: BuildAdapterArgs = {}): BuildAdapterResult {
  const mockChannel =
    args.mockChannel === undefined
      ? {
          send: vi.fn().mockResolvedValue({ id: "msg-123" }),
          isTextBased: () => true,
        }
      : args.mockChannel;

  const fetch =
    args.fetchImpl ?? vi.fn().mockResolvedValue(mockChannel);

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

describe("postToChannel()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T10:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts text-only content and resolves channelId from the registry", async () => {
    const { adapter, mockClient, mockChannel } = buildAdapter();

    await postToChannel({
      adapter,
      channel: "strength",
      content: "Hello strength channel.",
    });

    expect(mockClient.channels.fetch).toHaveBeenCalledTimes(1);
    expect(mockClient.channels.fetch).toHaveBeenCalledWith(
      "1000000000000000002",
    );
    expect(mockChannel!.send).toHaveBeenCalledTimes(1);
    const sendArg = mockChannel!.send.mock.calls[0]![0];
    expect(sendArg.content).toBe("Hello strength channel.");
    expect(sendArg.files).toEqual([]);
  });

  it("wraps a single attachment Buffer in an AttachmentBuilder with name + description", async () => {
    const { adapter, mockChannel } = buildAdapter();
    const buf = Buffer.from("png-bytes");

    await postToChannel({
      adapter,
      channel: "wins",
      content: "with attachment",
      attachments: [
        { name: "shot.png", data: buf, description: "screenshot" },
      ],
    });

    const sendArg = mockChannel!.send.mock.calls[0]![0];
    expect(sendArg.files).toHaveLength(1);
    const file = sendArg.files[0];
    expect(file).toBeInstanceOf(AttachmentBuilder);
    expect(file.name).toBe("shot.png");
    expect(file.description).toBe("screenshot");
    expect(file.attachment).toBe(buf);
  });

  it("returns {messageId, channelId, postedAt} from the send result, registry, and clock", async () => {
    const { adapter } = buildAdapter();

    const result = await postToChannel({
      adapter,
      channel: "wind-down",
      content: "bedtime",
    });

    expect(result).toEqual({
      messageId: "msg-123",
      channelId: "1000000000000000003",
      postedAt: new Date("2026-05-12T10:30:00.000Z").getTime(),
    });
  });

  it("passes a non-registered channel value through to client.channels.fetch verbatim (raw-snowflake path for user-created habits)", async () => {
    // Contract: `postToChannel.channel` accepts `ChannelName | string`. When
    // the value is NOT a registered `ChannelName`, it is treated as a raw
    // Discord snowflake id and passed to `client.channels.fetch` unchanged.
    // This is the path user-created habits take — their `habits.channel_id`
    // is the snowflake itself, not a name registered in `adapter.channelIds`.
    const { adapter, mockClient } = buildAdapter();

    await postToChannel({
      adapter,
      channel: "9999999999999999999",
      content: "x",
    });

    expect(mockClient.channels.fetch).toHaveBeenCalledWith(
      "9999999999999999999",
    );
  });

  it("throws a descriptive error when channels.fetch returns null", async () => {
    const { adapter } = buildAdapter({
      fetchImpl: vi.fn().mockResolvedValue(null),
    });

    await expect(
      postToChannel({
        adapter,
        channel: "morning-row",
        content: "x",
      }),
    ).rejects.toThrow(/not found|null|missing/i);
  });

  it("throws when the fetched channel is not text-based", async () => {
    const nonTextChannel: MockChannel = {
      send: vi.fn(),
      isTextBased: () => false,
    };
    const { adapter } = buildAdapter({ mockChannel: nonTextChannel });

    await expect(
      postToChannel({
        adapter,
        channel: "morning-row",
        content: "x",
      }),
    ).rejects.toThrow(/text/i);
    expect(nonTextChannel.send).not.toHaveBeenCalled();
  });

  it("propagates errors from channel.send (e.g. rate-limited)", async () => {
    const failingChannel: MockChannel = {
      send: vi.fn().mockRejectedValue(new Error("rate-limited")),
      isTextBased: () => true,
    };
    const { adapter } = buildAdapter({ mockChannel: failingChannel });

    await expect(
      postToChannel({
        adapter,
        channel: "sunday-review",
        content: "weekly recap",
      }),
    ).rejects.toThrow(/rate-limited/);
  });

  it("sends multiple attachments in order with AttachmentBuilders", async () => {
    const { adapter, mockChannel } = buildAdapter();
    const a = Buffer.from("aaa");
    const b = Buffer.from("bbb");
    const c = Buffer.from("ccc");

    await postToChannel({
      adapter,
      channel: "wins",
      content: "three attachments",
      attachments: [
        { name: "a.png", data: a },
        { name: "b.png", data: b, description: "second" },
        { name: "c.png", data: c },
      ],
    });

    const sendArg = mockChannel!.send.mock.calls[0]![0];
    expect(sendArg.files).toHaveLength(3);
    for (const file of sendArg.files) {
      expect(file).toBeInstanceOf(AttachmentBuilder);
    }
    expect(sendArg.files[0].name).toBe("a.png");
    expect(sendArg.files[0].attachment).toBe(a);
    expect(sendArg.files[0].description).toBeUndefined();

    expect(sendArg.files[1].name).toBe("b.png");
    expect(sendArg.files[1].attachment).toBe(b);
    expect(sendArg.files[1].description).toBe("second");

    expect(sendArg.files[2].name).toBe("c.png");
    expect(sendArg.files[2].attachment).toBe(c);
    expect(sendArg.files[2].description).toBeUndefined();
  });

  it("posts to morning-row channel using its registry ID", async () => {
    const { adapter, mockClient } = buildAdapter();

    await postToChannel({
      adapter,
      channel: "morning-row",
      content: "wake up",
    });

    expect(mockClient.channels.fetch).toHaveBeenCalledWith(
      "1000000000000000001",
    );
  });
});
