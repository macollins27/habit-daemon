// Task 20: Discord client init + channel registry.
//
// This is the construction-only half of the Discord adapter:
//
//   - createDiscordAdapter() — builds a discord.js Client with the three
//     gateway intents we need (Guilds, GuildMessages, MessageContent) and
//     pairs it with a typed channel-ID registry. It deliberately does NOT
//     call `client.login()` — that wiring lives in daemon-startup (later
//     task) so that unit tests, the CLI, and the scheduler can each decide
//     when (and whether) to actually connect to the Discord gateway.
//
//   - loadDiscordChannelIdsFromEnv() / loadDiscordBotTokenFromEnv() —
//     boundary helpers that read the documented env vars and validate
//     every value up-front so a misconfigured deployment fails loudly at
//     start-time rather than silently posting to the wrong channel (or
//     not at all) hours later.
//
// All five channels are mandatory: the daemon expects each posting verb
// (Task 21+) to have a destination. There is no "optional channel"
// concept — if you only need four of the five locally, point the fifth
// at a private test channel in your own server.
//
// A `clientFactory` injection point exists so the unit tests can verify
// intents and the no-auto-login invariant without spinning up the real
// discord.js Client (which opens timers, sets up a REST manager, etc.).
// Production code passes nothing and gets the real `new Client(opts)`.

import { Client, GatewayIntentBits, type ClientOptions } from "discord.js";

export type ChannelName =
  | "morning-row"
  | "strength"
  | "wind-down"
  | "wins"
  | "sunday-review";

export const CHANNEL_NAMES: readonly ChannelName[] = [
  "morning-row",
  "strength",
  "wind-down",
  "wins",
  "sunday-review",
];

export interface DiscordChannelIds {
  readonly "morning-row": string;
  readonly strength: string;
  readonly "wind-down": string;
  readonly wins: string;
  readonly "sunday-review": string;
}

export interface DiscordAdapterOptions {
  readonly botToken: string;
  readonly channelIds: DiscordChannelIds;
  // Injectable for testing — defaults to the real discord.js Client
  // constructor. Production callers pass nothing.
  readonly clientFactory?: (options: ClientOptions) => Client;
}

export interface DiscordAdapter {
  readonly client: Client;
  readonly channelIds: DiscordChannelIds;
}

// The three gateway intents the daemon will actually use:
//   - Guilds            — required to receive guild metadata and resolve channels.
//   - GuildMessages     — required to observe wins-channel messages (Task 22+).
//   - MessageContent    — required to read the body of wins messages (privileged
//                         intent; must be enabled in the Discord developer
//                         portal for the bot).
const REQUIRED_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

function defaultClientFactory(options: ClientOptions): Client {
  return new Client(options);
}

export function createDiscordAdapter(opts: DiscordAdapterOptions): DiscordAdapter {
  if (typeof opts.botToken !== "string" || opts.botToken.length === 0) {
    throw new Error("Discord bot token must be a non-empty string");
  }

  for (const name of CHANNEL_NAMES) {
    const id = opts.channelIds[name];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        `Discord channel ID for "${name}" must be a non-empty string`,
      );
    }
  }

  const factory = opts.clientFactory ?? defaultClientFactory;
  const client = factory({ intents: [...REQUIRED_INTENTS] });

  return {
    client,
    channelIds: opts.channelIds,
  };
}

// Env var name → channel-registry key. Kept as a const map so the load
// helper, the error messages, and any future docs all share one source
// of truth.
const ENV_VAR_BY_CHANNEL: Readonly<Record<ChannelName, string>> = {
  "morning-row": "DISCORD_CHANNEL_MORNING_ROW",
  strength: "DISCORD_CHANNEL_STRENGTH",
  "wind-down": "DISCORD_CHANNEL_WIND_DOWN",
  wins: "DISCORD_CHANNEL_WINS",
  "sunday-review": "DISCORD_CHANNEL_SUNDAY_REVIEW",
};

const BOT_TOKEN_ENV_VAR = "DISCORD_BOT_TOKEN";

function readRequiredEnv(env: NodeJS.ProcessEnv, varName: string): string {
  const value = env[varName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment variable: ${varName}`);
  }
  return value;
}

export function loadDiscordBotTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return readRequiredEnv(env, BOT_TOKEN_ENV_VAR);
}

export function loadDiscordChannelIdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiscordChannelIds {
  return {
    "morning-row": readRequiredEnv(env, ENV_VAR_BY_CHANNEL["morning-row"]),
    strength: readRequiredEnv(env, ENV_VAR_BY_CHANNEL.strength),
    "wind-down": readRequiredEnv(env, ENV_VAR_BY_CHANNEL["wind-down"]),
    wins: readRequiredEnv(env, ENV_VAR_BY_CHANNEL.wins),
    "sunday-review": readRequiredEnv(env, ENV_VAR_BY_CHANNEL["sunday-review"]),
  };
}
