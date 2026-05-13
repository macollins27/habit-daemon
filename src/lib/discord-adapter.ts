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
  Status,
  type ClientOptions,
  type Message,
} from "discord.js";
import type Database from "better-sqlite3";

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
  /**
   * `true` iff the underlying websocket is in the `Status.Ready` state.
   *
   * Surfaced for the `/api/health` endpoint: the daemon wires this
   * callback into `ApiDeps.discordConnected` so a UI / monitor can tell
   * whether the bot is currently connected to the Discord gateway. We
   * read `client.ws.status` directly rather than tracking the `ready` /
   * `disconnect` events ourselves — discord.js owns that state machine
   * and any duplication would risk drift after reconnects.
   */
  readonly isReady: () => boolean;
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
    isReady: (): boolean => client.ws.status === Status.Ready,
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

/**
 * `channel` accepts either:
 *   - a known `ChannelName` (Phase A seed channels resolved through
 *     `adapter.channelIds`), or
 *   - a raw Discord snowflake ID (any other string) for user-created habits
 *     whose `channel_id` is configured directly on the row.
 *
 * The resolver below tries the registry lookup first; if the value isn't a
 * registered name, it is passed verbatim to `client.channels.fetch`. This
 * keeps Phase-A seed habits routing through the named registry while letting
 * user-created habits supply a snowflake without invent a name for it.
 */
export interface PostToChannelOptions {
  readonly adapter: DiscordAdapter;
  readonly channel: ChannelName | string;
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

  // Resolve the snowflake id. Two paths:
  //   1. `channel` is a registered ChannelName — look up the snowflake in
  //      `adapter.channelIds`. Phase-A seed habits take this path.
  //   2. `channel` is anything else — treat as a raw snowflake id and pass
  //      verbatim to `client.channels.fetch`. User-created habits (whose
  //      `habits.channel_id` column is the snowflake itself) take this path.
  // Either way the fetched channel must be text-based; non-text channels
  // fail loud below regardless of how we resolved the id.
  const channelId = isChannelNameKnown(adapter.channelIds, channel)
    ? adapter.channelIds[channel]
    : channel;

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

// ---------------------------------------------------------------------------
// Task 22: inbound listener.
//
// `subscribeMessages` is the single inbound read path for the daemon. It
// registers exactly one `messageCreate` listener on the discord.js Client
// and, for every non-bot message observed in one of the three *active*
// channels (`morning-row`, `strength`, `wind-down`), looks up the active
// `habit_runs` row that matches:
//
//     habit.channel_id   == msg.channelId
//     habit_run.fire_date == today (local time, per ADR 0001)
//     habit_run.status   IN ('pending','partial')
//
// If a row is found, the caller's `handler` is invoked with
// `{run, message, channelName}`. If no row matches, the listener is a no-op
// — there is no active habit for this message, so it isn't ours to handle.
//
// The `wins` and `sunday-review` channels are bot-output-only — no listener
// fires for messages in those channels even if the message somehow makes it
// past Discord's permissions.
//
// Author matching: Phase A is single-user, so we filter only on
// `author.bot === true` (skip bots) and accept all human messages. When the
// design grows a per-habit user-id mapping, extend this filter.
//
// Async handler errors are caught and logged via `console.error` instead of
// being allowed to propagate up the discord.js event-emitter stack. The
// listener intentionally survives a handler crash so subsequent messages
// still get a chance to be processed.
// ---------------------------------------------------------------------------

export interface ActiveHabitRun {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
  readonly current_level: number;
  readonly status: "pending" | "partial";
  readonly proof_rejection_callout_due: number;
}

export interface MessageMatch {
  readonly run: ActiveHabitRun;
  readonly message: Message;
  readonly channelName: ChannelName;
}

export interface SubscribeMessagesOptions {
  readonly adapter: DiscordAdapter;
  readonly db: Database.Database;
  readonly handler: (match: MessageMatch) => Promise<void> | void;
  // Injectable for testing. Defaults to `() => new Date()`.
  readonly now?: () => Date;
}

export type Unsubscribe = () => void;

// The three channels the daemon actually listens to. `wins` and
// `sunday-review` are bot-output-only.
const ACTIVE_CHANNEL_NAMES: readonly ChannelName[] = [
  "morning-row",
  "strength",
  "wind-down",
];

function buildActiveChannelLookup(
  channelIds: DiscordChannelIds,
): ReadonlyMap<string, ChannelName> {
  const map = new Map<string, ChannelName>();
  for (const name of ACTIVE_CHANNEL_NAMES) {
    map.set(channelIds[name], name);
  }
  return map;
}

// YYYY-MM-DD in process local time. Matches the daemon's `fire_date`
// writer (ADR 0001: cron expressions are interpreted in local time).
function localDateString(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function subscribeMessages(opts: SubscribeMessagesOptions): Unsubscribe {
  const { adapter, db, handler } = opts;
  const nowFn = opts.now ?? (() => new Date());

  const activeChannels = buildActiveChannelLookup(adapter.channelIds);

  // Single-row lookup. Joining channel_id → habit_id inline keeps the
  // listener stateless: no in-memory cache of habit rows to keep coherent
  // with schema changes (Phase B plan-change pipeline).
  const lookupRun = db.prepare(
    `SELECT id, habit_id, fire_date, current_level, status,
            proof_rejection_callout_due
       FROM habit_runs
      WHERE habit_id = (SELECT id FROM habits WHERE channel_id = ?)
        AND fire_date = ?
        AND status IN ('pending', 'partial')
      LIMIT 1`,
  );

  const onMessage = (msg: Message): void => {
    // Diagnostic logging — every observed messageCreate is logged with the
    // discriminators the handler uses to decide whether to process. If a
    // user-posted message stops showing up here, the gateway/intent/connection
    // layer is the problem, not the handler.
    process.stdout.write(
      `[discord-listener] messageCreate channelId=${msg.channelId} ` +
        `author_bot=${msg.author?.bot ?? "(null)"} ` +
        `content_len=${msg.content?.length ?? 0} ` +
        `attachments=${msg.attachments?.size ?? 0}\n`,
    );

    // discord.js's Message.author can be null in exotic webhook cases. The
    // optional chain plus `?? false` collapses both "no author" and
    // "human author" into "do not skip".
    if (msg.author?.bot === true) {
      process.stdout.write(`[discord-listener] skip: author is a bot\n`);
      return;
    }

    const channelName = activeChannels.get(msg.channelId);
    if (channelName === undefined) {
      process.stdout.write(
        `[discord-listener] skip: channel ${msg.channelId} is not in the active list\n`,
      );
      return;
    }

    const today = localDateString(nowFn());
    const row = lookupRun.get(adapter.channelIds[channelName], today) as
      | ActiveHabitRun
      | undefined;
    if (row === undefined) {
      process.stdout.write(
        `[discord-listener] skip: no active habit_run for channel=${channelName} fire_date=${today}\n`,
      );
      return;
    }
    process.stdout.write(
      `[discord-listener] match: invoking handler for run=${row.id} channel=${channelName}\n`,
    );

    const match: MessageMatch = {
      run: row,
      message: msg,
      channelName,
    };

    let result: Promise<void> | void;
    try {
      result = handler(match);
    } catch (err: unknown) {
      // Synchronous throw from handler — log and swallow.
      console.error("[discord-listener] handler threw synchronously", err);
      return;
    }

    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch((err: unknown) => {
        console.error("[discord-listener] handler rejected", err);
      });
    }
  };

  adapter.client.on("messageCreate", onMessage);

  return () => {
    adapter.client.off("messageCreate", onMessage);
  };
}
