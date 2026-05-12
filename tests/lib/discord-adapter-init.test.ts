// Task 20: Discord client init + channel registry.
//
// This module is the construction-only half of the Discord adapter. It does
// not call `client.login()` — that wiring lives in daemon-startup (later
// task). The unit tests here cover:
//
//   1. createDiscordAdapter() — happy path (mocked clientFactory), missing
//      bot token, missing channel IDs (one per channel), and the fact that
//      no auto-login happens.
//   2. loadDiscordChannelIdsFromEnv() / loadDiscordBotTokenFromEnv() — env
//      parsing for the five DISCORD_CHANNEL_* vars and DISCORD_BOT_TOKEN,
//      with missing-var failures.
//   3. A single integration test that constructs an adapter without a
//      clientFactory, asserting the returned `client` is a real discord.js
//      Client instance (i.e. the default factory wires through correctly).

import { describe, it, expect, vi } from "vitest";
import { Client, GatewayIntentBits, type ClientOptions } from "discord.js";
import {
  createDiscordAdapter,
  loadDiscordBotTokenFromEnv,
  loadDiscordChannelIdsFromEnv,
  CHANNEL_NAMES,
  type ChannelName,
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

function validEnv(): NodeJS.ProcessEnv {
  return {
    DISCORD_BOT_TOKEN: "test-bot-token",
    DISCORD_CHANNEL_MORNING_ROW: "1000000000000000001",
    DISCORD_CHANNEL_STRENGTH: "1000000000000000002",
    DISCORD_CHANNEL_WIND_DOWN: "1000000000000000003",
    DISCORD_CHANNEL_WINS: "1000000000000000004",
    DISCORD_CHANNEL_SUNDAY_REVIEW: "1000000000000000005",
  };
}

describe("CHANNEL_NAMES", () => {
  it("exposes the five canonical channel names", () => {
    expect(CHANNEL_NAMES).toEqual([
      "morning-row",
      "strength",
      "wind-down",
      "wins",
      "sunday-review",
    ]);
    // Width check so the ChannelName union does not silently drift.
    const five: 5 = CHANNEL_NAMES.length as 5;
    expect(five).toBe(5);
  });
});

describe("createDiscordAdapter()", () => {
  it("constructs a client via the injected factory with the three required intents", () => {
    const captured: { options?: ClientOptions } = {};
    const fakeClient = { login: vi.fn() } as unknown as Client;
    const factory = (options: ClientOptions): Client => {
      captured.options = options;
      return fakeClient;
    };

    const adapter = createDiscordAdapter({
      botToken: "test-bot-token",
      channelIds: validChannelIds(),
      clientFactory: factory,
    });

    expect(captured.options).toBeDefined();
    expect(captured.options?.intents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]);
    expect(adapter.client).toBe(fakeClient);
    expect(adapter.channelIds).toEqual(validChannelIds());
  });

  it("does not auto-login the client", () => {
    const loginSpy = vi.fn();
    const fakeClient = { login: loginSpy } as unknown as Client;

    createDiscordAdapter({
      botToken: "test-bot-token",
      channelIds: validChannelIds(),
      clientFactory: () => fakeClient,
    });

    expect(loginSpy).not.toHaveBeenCalled();
  });

  it("throws when botToken is empty", () => {
    expect(() =>
      createDiscordAdapter({
        botToken: "",
        channelIds: validChannelIds(),
        clientFactory: () => ({ login: vi.fn() }) as unknown as Client,
      }),
    ).toThrow(/bot token/i);
  });

  it("throws naming the channel when any channel ID is empty", () => {
    const cases: readonly ChannelName[] = CHANNEL_NAMES;
    for (const missing of cases) {
      const channelIds = { ...validChannelIds(), [missing]: "" } as DiscordChannelIds;
      expect(
        () =>
          createDiscordAdapter({
            botToken: "test-bot-token",
            channelIds,
            clientFactory: () => ({ login: vi.fn() }) as unknown as Client,
          }),
        `expected throw for missing channel ${missing}`,
      ).toThrow(new RegExp(missing));
    }
  });

  it("returns a real discord.js Client when no factory is injected", () => {
    const adapter = createDiscordAdapter({
      botToken: "test-bot-token",
      channelIds: validChannelIds(),
    });

    expect(adapter.client).toBeInstanceOf(Client);
    expect(adapter.channelIds).toEqual(validChannelIds());
  });
});

describe("loadDiscordBotTokenFromEnv()", () => {
  it("returns the DISCORD_BOT_TOKEN value when set", () => {
    expect(loadDiscordBotTokenFromEnv(validEnv())).toBe("test-bot-token");
  });

  it("throws when DISCORD_BOT_TOKEN is missing", () => {
    const env = { ...validEnv() };
    delete env.DISCORD_BOT_TOKEN;
    expect(() => loadDiscordBotTokenFromEnv(env)).toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("throws when DISCORD_BOT_TOKEN is empty", () => {
    expect(() =>
      loadDiscordBotTokenFromEnv({ ...validEnv(), DISCORD_BOT_TOKEN: "" }),
    ).toThrow(/DISCORD_BOT_TOKEN/);
  });
});

describe("loadDiscordChannelIdsFromEnv()", () => {
  it("maps the five DISCORD_CHANNEL_* env vars onto the registry", () => {
    expect(loadDiscordChannelIdsFromEnv(validEnv())).toEqual(validChannelIds());
  });

  it("throws naming each missing env var", () => {
    const envVarByChannel: Record<ChannelName, string> = {
      "morning-row": "DISCORD_CHANNEL_MORNING_ROW",
      strength: "DISCORD_CHANNEL_STRENGTH",
      "wind-down": "DISCORD_CHANNEL_WIND_DOWN",
      wins: "DISCORD_CHANNEL_WINS",
      "sunday-review": "DISCORD_CHANNEL_SUNDAY_REVIEW",
    };

    for (const [, varName] of Object.entries(envVarByChannel)) {
      const env = { ...validEnv() };
      delete env[varName];
      expect(
        () => loadDiscordChannelIdsFromEnv(env),
        `expected throw when ${varName} is missing`,
      ).toThrow(new RegExp(varName));
    }
  });

  it("throws when an env var is empty string", () => {
    const env = { ...validEnv(), DISCORD_CHANNEL_WINS: "" };
    expect(() => loadDiscordChannelIdsFromEnv(env)).toThrow(/DISCORD_CHANNEL_WINS/);
  });
});
