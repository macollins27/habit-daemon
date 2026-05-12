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

import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  type ClientOptions,
} from "discord.js";

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

// ---------------------------------------------------------------------------
// Task 21: outbound poster.
//
// `postToChannel` is the single outbound write path for the daemon. Every
// scheduled habit prompt, win celebration, and Sunday review goes through
// this verb so that:
//
//   - Channel resolution is centralized (no caller hand-holds a snowflake ID).
//   - Attachments use a domain-shaped `AttachmentSpec` (Buffer + name +
//     optional description) rather than discord.js types leaking into
//     orchestration code.
//   - The runtime guards (unknown channel name, fetch returns null, fetched
//     channel is not text-based) all fail loud — there is no silent drop.
//
// `channel.send` rejections (rate limits, network errors, message-too-long)
// propagate to the caller; retry/back-off policy lives at the orchestrator
// layer where it has access to the habit run row and can decide whether to
// reschedule or surface the failure.
//
// Note on empty messages: discord.js rejects `send({content: "", files: []})`
// — `postToChannel` does not pre-validate that, because the only realistic
// caller path always supplies either content or attachments. If a future
// caller needs the guard, add it at that caller, not here.
// ---------------------------------------------------------------------------

export interface AttachmentSpec {
  readonly name: string;
  readonly data: Buffer;
  readonly description?: string;
}

export interface PostToChannelOptions {
  readonly adapter: DiscordAdapter;
  readonly channel: ChannelName;
  readonly content: string;
  readonly attachments?: readonly AttachmentSpec[];
}

export interface PostResult {
  readonly messageId: string;
  readonly channelId: string;
  readonly postedAt: number;
}

// Narrow shape we actually rely on from a discord.js TextBasedChannel. We
// intentionally avoid importing the full discord.js channel union because
// `channels.fetch` returns a wide `Channel | null` that requires the
// `isTextBased()` narrowing to call `.send`.
interface TextChannelLike {
  readonly isTextBased: () => boolean;
  readonly send: (payload: {
    readonly content: string;
    readonly files: readonly AttachmentBuilder[];
  }) => Promise<{ readonly id: string }>;
}

function isChannelNameKnown(
  channelIds: DiscordChannelIds,
  name: string,
): name is ChannelName {
  return Object.prototype.hasOwnProperty.call(channelIds, name);
}

export async function postToChannel(
  opts: PostToChannelOptions,
): Promise<PostResult> {
  const { adapter, channel, content, attachments } = opts;

  // Runtime guard mirroring the compile-time `ChannelName` union: callers
  // that bypass typing (e.g. dynamic dispatch with a string from config)
  // still get a loud failure instead of a silent post to the wrong place.
  if (!isChannelNameKnown(adapter.channelIds, channel)) {
    throw new Error(`Unknown Discord channel name: "${channel}"`);
  }

  const channelId = adapter.channelIds[channel];

  const fetched = await adapter.client.channels.fetch(channelId);
  if (fetched === null) {
    throw new Error(
      `Discord channel "${channel}" (id=${channelId}) not found`,
    );
  }

  const maybeText = fetched as unknown as TextChannelLike;
  if (typeof maybeText.isTextBased !== "function" || !maybeText.isTextBased()) {
    throw new Error(
      `Discord channel "${channel}" (id=${channelId}) is not a text-based channel`,
    );
  }

  const files: readonly AttachmentBuilder[] = (attachments ?? []).map((spec) =>
    new AttachmentBuilder(spec.data, {
      name: spec.name,
      description: spec.description,
    }),
  );

  const message = await maybeText.send({ content, files });

  return {
    messageId: message.id,
    channelId,
    postedAt: Date.now(),
  };
}
