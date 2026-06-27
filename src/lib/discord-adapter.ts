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

import { localDateString } from "./local-date.js";

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
  readonly proof_type: string;
  readonly proof_config_json: string;
}

export interface MessageMatch {
  readonly run: ActiveHabitRun;
  readonly message: Message;
  readonly channelName: ChannelName;
}

/**
 * Optional chat fall-through handler for `subscribeMessages` and
 * `catchUpOnStartup`. Invoked when a non-bot message lands in one of the
 * three ACTIVE channels but no pending/partial habit_run matches today's
 * fire_date — i.e. the user is talking, not submitting proof.
 *
 * `channelName` is the resolved ChannelName for the message's channel. It is
 * always present (the chat handler only fires for active channels). The
 * `null` branch in the type is reserved for a future extension that allows
 * chat in non-active channels; today's wiring never passes null.
 */
export interface ChatFallthroughArgs {
  readonly channelId: string;
  readonly channelName: ChannelName | null;
  readonly text: string;
  readonly message: Message;
}

export type ChatHandler = (
  args: ChatFallthroughArgs,
) => Promise<void> | void;

export interface SubscribeMessagesOptions {
  readonly adapter: DiscordAdapter;
  readonly db: Database.Database;
  readonly handler: (match: MessageMatch) => Promise<void> | void;
  /**
   * Optional chat fall-through. Fires when an active-channel message has
   * no matching pending/partial habit_run. When omitted, the listener
   * preserves the prior behaviour of silently skipping such messages
   * (backward-compatible).
   */
  readonly chatHandler?: ChatHandler;
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

// Single-channel mode: multiple ChannelNames can share the same snowflake (the
// user collapses #morning-row, #strength, #wind-down — and optionally #wins and
// #sunday-review — into one #habits channel). The lookup must be many-to-many
// or the last write wins and the listener silently loses one of the names.
function buildActiveChannelLookup(
  channelIds: DiscordChannelIds,
): ReadonlyMap<string, readonly ChannelName[]> {
  const map = new Map<string, ChannelName[]>();
  for (const name of ACTIVE_CHANNEL_NAMES) {
    const id = channelIds[name];
    const existing = map.get(id);
    if (existing) {
      existing.push(name);
    } else {
      map.set(id, [name]);
    }
  }
  return map;
}

// SQL for the multi-row active-run lookup keyed by (channel_id, fire_date).
// Single source of truth for both the live listener (subscribeMessages) and
// the bootstrap catch-up sweep (catchUpOnStartup) so the two paths cannot
// drift in their matching semantics.
//
// Single-channel mode: with multiple habits sharing a channel_id, we must
// return ALL active runs and let the routing layer (message-shape pre-filter)
// pick the candidate(s). The previous scalar-subquery pattern
// (`habit_id = (SELECT id FROM habits WHERE channel_id = ?)`) was broken
// once channel_id was no longer unique — SQLite picks one row
// nondeterministically. A JOIN is correct here.
//
// proof_type + proof_config_json are pulled so the pre-filter can decide
// which runs accept this message's shape (attachment vs trigger phrase).
const LOOKUP_ACTIVE_RUNS_SQL =
  `SELECT r.id, r.habit_id, r.fire_date, r.current_level, r.status,
          r.proof_rejection_callout_due,
          h.proof_type, h.proof_config_json
     FROM habit_runs r
     JOIN habits h ON h.id = r.habit_id
    WHERE h.channel_id = ?
      AND r.fire_date = ?
      AND r.status IN ('pending', 'partial')
    ORDER BY r.current_level DESC, r.fired_at ASC`;

interface ProofConfigPhrase {
  readonly stage_a_phrase?: string;
}

/**
 * Message-shape pre-filter for single-channel mode routing.
 *
 * Given a list of all today's pending/partial runs that share the message's
 * channel, return the subset whose `proof_type` accepts the message's shape:
 *
 *   - concept2_api+photo_fallback  → accepts messages WITH an attachment
 *   - training_log_photo           → accepts messages WITH an attachment
 *   - typed_msg+garmin_sleep       → accepts text messages containing the
 *                                    configured `stage_a_phrase`
 *
 * Anything else (no attachment, no phrase match, unknown proof_type) returns
 * `false` — those messages fall through to chat.
 */
function filterRunsByMessageShape(
  runs: ReadonlyArray<ActiveHabitRun>,
  hasAttachment: boolean,
  text: string,
): ReadonlyArray<ActiveHabitRun> {
  const lowerText = text.toLowerCase();
  return runs.filter((run) => {
    const proofType = run.proof_type;
    if (proofType === "concept2_api+photo_fallback") return hasAttachment;
    if (proofType === "training_log_photo") return hasAttachment;
    if (proofType === "typed_msg+garmin_sleep") {
      try {
        const cfg = JSON.parse(run.proof_config_json) as ProofConfigPhrase;
        const phrase = (cfg.stage_a_phrase ?? "").toLowerCase();
        return phrase.length > 0 && lowerText.includes(phrase);
      } catch {
        return false;
      }
    }
    if (proofType === "alignment_text") {
      // A daily-alignment proof is a structured answer to the four questions.
      // Require >= 2 of the question markers so an idle chat message in the
      // same channel falls through to chat instead of being judged + rejected.
      // The Claude judge then enforces substantive answers to all four.
      const markers = ["avoid", "start", "win", "interfer"];
      const hits = markers.filter((m) => lowerText.includes(m)).length;
      return hits >= 2;
    }
    return false;
  });
}

/**
 * Pick a representative ChannelName for a run when multiple names share a
 * snowflake. We prefer the name that matches the run's habit_id mapping
 * (morning-row run → "morning-row" channelName) so the proof handler's
 * existing logging and post resolution still make sense even when the live
 * channel is collapsed. Falls back to the first available name if no match.
 */
function pickChannelNameForRun(
  names: readonly ChannelName[],
  habitId: string,
): ChannelName {
  // habit_id → ChannelName map. The three Phase A habits seed their habit_id
  // equal to their domain-ish slug; "strength-mwf" maps to "strength".
  const habitToChannel: Record<string, ChannelName> = {
    "morning-row": "morning-row",
    "strength-mwf": "strength",
    "wind-down": "wind-down",
  };
  const preferred = habitToChannel[habitId];
  if (preferred !== undefined && names.includes(preferred)) {
    return preferred;
  }
  // User-created habits / unknown habit_id — return the first available name.
  return names[0] as ChannelName;
}

export function subscribeMessages(opts: SubscribeMessagesOptions): Unsubscribe {
  const { adapter, db, handler, chatHandler } = opts;
  const nowFn = opts.now ?? (() => new Date());

  const activeChannels = buildActiveChannelLookup(adapter.channelIds);

  // Multi-row lookup. Joining channel_id → habit_id inline keeps the
  // listener stateless: no in-memory cache of habit rows to keep coherent
  // with schema changes (Phase B plan-change pipeline). In single-channel
  // mode this can return multiple rows; the pre-filter step below routes
  // by message shape (attachment vs trigger phrase).
  const lookupAllRuns = db.prepare(LOOKUP_ACTIVE_RUNS_SQL);

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

    // Phase 5: advance the per-channel cursor on EVERY observed message
    // (before bot / active-channel / lookup-run skips). The cursor is the
    // "last thing we saw" signal used by the bootstrap catch-up sweep to
    // decide what to replay after a restart; it is independent of whether
    // the handler ends up processing the message. better-sqlite3 is sync,
    // so this commits before the (async) handler can race. Failures here
    // are best-effort: log and continue, never block live message handling.
    try {
      const createdIso = (
        msg.createdAt instanceof Date ? msg.createdAt : new Date()
      ).toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO discord_channel_cursors (channel_id, last_seen_iso, updated_at)
         VALUES (?, ?, ?)`,
      ).run(msg.channelId, createdIso, Date.now());
    } catch (err: unknown) {
      console.error(
        `[discord-listener] cursor write failed for channel ${msg.channelId}:`,
        err,
      );
    }

    // discord.js's Message.author can be null in exotic webhook cases. The
    // optional chain plus `?? false` collapses both "no author" and
    // "human author" into "do not skip".
    if (msg.author?.bot === true) {
      process.stdout.write(`[discord-listener] skip: author is a bot\n`);
      return;
    }

    const channelNames = activeChannels.get(msg.channelId);
    if (channelNames === undefined) {
      process.stdout.write(
        `[discord-listener] skip: channel ${msg.channelId} is not in the active list\n`,
      );
      return;
    }
    // Representative ChannelName for diagnostic logging / chat-fall-through.
    // When the snowflake maps to a single name this is just that name; when
    // multiple names share the snowflake (single-channel mode) we pick the
    // first for the chat-side dispatch (the chat orchestrator no longer
    // biases on channelName — see prompt-templates/user-chat.ts).
    const representativeChannelName = channelNames[0] as ChannelName;

    const today = localDateString(nowFn());
    const allRuns = lookupAllRuns.all(msg.channelId, today) as ActiveHabitRun[];

    const hasAttachment = (msg.attachments?.size ?? 0) > 0;
    const text = msg.content ?? "";
    const candidates = filterRunsByMessageShape(allRuns, hasAttachment, text);

    const dispatchChat = (logTag: string): void => {
      if (chatHandler === undefined) {
        process.stdout.write(
          `[discord-listener] skip: ${logTag} (no chatHandler wired) channel=${representativeChannelName} fire_date=${today}\n`,
        );
        return;
      }
      process.stdout.write(
        `[discord-listener] chat-fallthrough: ${logTag} channel=${representativeChannelName}\n`,
      );
      let chatResult: Promise<void> | void;
      try {
        chatResult = chatHandler({
          channelId: msg.channelId,
          channelName: representativeChannelName,
          text,
          message: msg,
        });
      } catch (err: unknown) {
        console.error(
          "[discord-listener] chatHandler threw synchronously",
          err,
        );
        return;
      }
      if (
        chatResult &&
        typeof (chatResult as Promise<void>).catch === "function"
      ) {
        (chatResult as Promise<void>).catch((err: unknown) => {
          console.error("[discord-listener] chatHandler rejected", err);
        });
      }
    };

    // Routing:
    //   - 0 candidates: fall through to chat (or silent skip if no chatHandler).
    //     "0 candidates" can mean (a) no active runs at all, or (b) active runs
    //     exist but none accept this message's shape — both are conversational.
    //   - 1 candidate: dispatch the proof handler with that single run.
    //   - 2+ candidates: ambiguous — fall through to chat. The coach prompt
    //     handles "which habit?" conversationally; no special routing state.
    if (candidates.length === 0) {
      dispatchChat(
        allRuns.length === 0
          ? "no active habit_run"
          : `no proof-shape match (${allRuns.length} active run(s))`,
      );
      return;
    }

    if (candidates.length >= 2) {
      process.stdout.write(
        `[discord-listener] ambiguous-proof: ${candidates.length} candidates match channel=${representativeChannelName} — falling through to chat handler for clarification\n`,
      );
      dispatchChat(`ambiguous-proof (${candidates.length} candidates)`);
      return;
    }

    // candidates.length === 1
    const row = candidates[0] as ActiveHabitRun;
    const channelNameForRun = pickChannelNameForRun(channelNames, row.habit_id);
    process.stdout.write(
      `[discord-listener] match: invoking handler for run=${row.id} channel=${channelNameForRun}\n`,
    );

    const match: MessageMatch = {
      run: row,
      message: msg,
      channelName: channelNameForRun,
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

// ---------------------------------------------------------------------------
// Phase 5: bootstrap catch-up sweep.
//
// When the daemon process restarts (e.g. on a code deploy or launchd reload),
// any Discord messageCreate events delivered during the restart window are
// lost — discord.js does not buffer events across process lifetimes. The
// catch-up sweep closes that gap: on bootstrap, after the Discord client is
// `ready` but before the live `subscribeMessages` listener is wired up, fetch
// recent messages from each active channel and replay any whose `createdAt`
// is newer than the per-channel cursor through the same handler the live
// listener will use.
//
// Invariants (mirrored from subscribeMessages.onMessage so the two paths stay
// behaviourally identical):
//   - The cursor advances on every observed message, regardless of whether
//     the handler ran.
//   - Bot-authored messages are skipped.
//   - A message only triggers `handler` if there is a pending/partial
//     habit_runs row for today on the channel's habit.
//   - Per-channel errors are logged and swallowed: a fetch failure on one
//     channel must not abort the whole sweep, and must not crash bootstrap.
//   - Replay order is chronological (oldest first) so the handler sees the
//     same ordering it would see live.
// ---------------------------------------------------------------------------

export interface CatchUpChannelResult {
  readonly channelName: ChannelName;
  readonly fetched: number;
  readonly replayed: number;
  readonly skipped: number;
}

export interface CatchUpResult {
  readonly perChannel: ReadonlyArray<CatchUpChannelResult>;
}

export interface CatchUpOptions {
  readonly adapter: DiscordAdapter;
  readonly db: Database.Database;
  readonly handler: (match: MessageMatch) => Promise<void> | void;
  /**
   * Optional chat fall-through. Fires during replay for active-channel
   * messages that have no matching pending/partial habit_run. Mirrors the
   * subscribeMessages chatHandler contract so the live + catch-up paths
   * stay behaviourally identical.
   */
  readonly chatHandler?: ChatHandler;
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Max messages to fetch per channel. Default 50. */
  readonly limit?: number;
}

// Narrow shape of the discord.js TextBasedChannel surface we touch. We avoid
// importing the wide channel union from discord.js because `channels.fetch`
// returns `Channel | null` and requires `isTextBased()` narrowing to read
// `.messages`. The shape below is the minimum the sweep needs.
interface FetchableMessagesChannel {
  readonly isTextBased: () => boolean;
  readonly messages: {
    readonly fetch: (opts: {
      readonly limit: number;
    }) => Promise<Map<string, Message> | { readonly values: () => Iterable<Message> }>;
  };
}

function isFetchableMessagesChannel(c: unknown): c is FetchableMessagesChannel {
  if (c === null || typeof c !== "object") return false;
  const obj = c as { isTextBased?: unknown; messages?: unknown };
  if (typeof obj.isTextBased !== "function") return false;
  if (typeof obj.messages !== "object" || obj.messages === null) return false;
  const msgs = obj.messages as { fetch?: unknown };
  return typeof msgs.fetch === "function";
}

function writeCursor(
  db: Database.Database,
  channelId: string,
  createdAt: Date,
): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO discord_channel_cursors (channel_id, last_seen_iso, updated_at)
       VALUES (?, ?, ?)`,
    ).run(channelId, createdAt.toISOString(), Date.now());
  } catch (err: unknown) {
    console.error(
      `[catch-up] cursor write failed for channel ${channelId}:`,
      err,
    );
  }
}

export async function catchUpOnStartup(
  opts: CatchUpOptions,
): Promise<CatchUpResult> {
  const { adapter, db, handler, chatHandler } = opts;
  const nowFn = opts.now ?? (() => new Date());
  const limit = opts.limit ?? 50;

  const lookupAllRuns = db.prepare(LOOKUP_ACTIVE_RUNS_SQL);
  const readCursor = db.prepare(
    `SELECT last_seen_iso FROM discord_channel_cursors WHERE channel_id = ?`,
  );

  const results: CatchUpChannelResult[] = [];
  const activeChannels = buildActiveChannelLookup(adapter.channelIds);

  // Single-channel mode: multiple ChannelNames may share one snowflake. We
  // iterate over UNIQUE snowflakes (not names) so each underlying Discord
  // channel is fetched and replayed exactly once. We still emit one result
  // entry per ACTIVE_CHANNEL_NAME for backwards compat with callers that
  // log per-name — entries for names sharing a snowflake all reflect the
  // same fetched/replayed/skipped counts.
  const visitedChannelIds = new Set<string>();
  const perChannelByName = new Map<ChannelName, CatchUpChannelResult>();

  for (const channelName of ACTIVE_CHANNEL_NAMES) {
    const channelId = adapter.channelIds[channelName];

    if (visitedChannelIds.has(channelId)) {
      // Already processed via another name that shares this snowflake.
      // Mirror the counts from the first visit so logs stay symmetric.
      const sharedNames = activeChannels.get(channelId) ?? [];
      const firstName = sharedNames[0];
      const prev =
        firstName !== undefined ? perChannelByName.get(firstName) : undefined;
      const entry: CatchUpChannelResult = {
        channelName,
        fetched: prev?.fetched ?? 0,
        replayed: prev?.replayed ?? 0,
        skipped: prev?.skipped ?? 0,
      };
      perChannelByName.set(channelName, entry);
      results.push(entry);
      continue;
    }
    visitedChannelIds.add(channelId);

    // Read cursor. Missing row → cursorMs === null → replay everything we
    // fetch (up to `limit`). NaN guard: a malformed last_seen_iso shouldn't
    // crash startup; treat as "no cursor" and replay defensively.
    const cursorRow = readCursor.get(channelId) as
      | { readonly last_seen_iso: string }
      | undefined;
    let cursorMs: number | null = null;
    if (cursorRow !== undefined) {
      const parsed = Date.parse(cursorRow.last_seen_iso);
      cursorMs = Number.isFinite(parsed) ? parsed : null;
    }

    let channel: unknown;
    try {
      channel = await adapter.client.channels.fetch(channelId);
    } catch (err: unknown) {
      console.error(
        `[catch-up] fetch channel ${channelName} (${channelId}) failed:`,
        err,
      );
      const entry: CatchUpChannelResult = {
        channelName,
        fetched: 0,
        replayed: 0,
        skipped: 0,
      };
      perChannelByName.set(channelName, entry);
      results.push(entry);
      continue;
    }

    if (!isFetchableMessagesChannel(channel) || !channel.isTextBased()) {
      const entry: CatchUpChannelResult = {
        channelName,
        fetched: 0,
        replayed: 0,
        skipped: 0,
      };
      perChannelByName.set(channelName, entry);
      results.push(entry);
      continue;
    }

    let messages: Message[];
    try {
      const collection = await channel.messages.fetch({ limit });
      // discord.js returns a Collection (extends Map). We accept anything
      // with a .values() iterator so the tests can use a plain Map.
      const iterable =
        typeof (collection as Map<string, Message>).values === "function"
          ? (collection as Map<string, Message>).values()
          : (collection as { values: () => Iterable<Message> }).values();
      messages = [...iterable];
    } catch (err: unknown) {
      console.error(
        `[catch-up] fetch messages for ${channelName} failed:`,
        err,
      );
      const entry: CatchUpChannelResult = {
        channelName,
        fetched: 0,
        replayed: 0,
        skipped: 0,
      };
      perChannelByName.set(channelName, entry);
      results.push(entry);
      continue;
    }

    const fetched = messages.length;
    const sharedNames = activeChannels.get(channelId) ?? [channelName];
    // Representative name for chat-fallthrough dispatch when this snowflake
    // maps to multiple ChannelNames (single-channel mode).
    const representativeChannelName = sharedNames[0] as ChannelName;

    // Newer-than-cursor + non-bot, in chronological order (oldest first).
    const fresh = messages
      .filter((m) =>
        cursorMs === null
          ? true
          : (m.createdAt instanceof Date ? m.createdAt.getTime() : 0) > cursorMs,
      )
      .filter((m) => m.author?.bot !== true)
      .sort((a, b) => {
        const at = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
        const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
        return at - bt;
      });

    let replayed = 0;
    let skipped = 0;

    for (const msg of fresh) {
      // Advance the cursor first (matches the live-listener invariant: the
      // cursor records "what we observed", not "what we handled").
      writeCursor(
        db,
        msg.channelId,
        msg.createdAt instanceof Date ? msg.createdAt : nowFn(),
      );

      // Match to today's pending/partial runs using the same SQL as the live
      // listener, then route by message-shape pre-filter. "Today" here is the
      // daemon's local date at the moment of the sweep.
      const today = localDateString(nowFn());
      const allRuns = lookupAllRuns.all(msg.channelId, today) as ActiveHabitRun[];
      const hasAttachment = (msg.attachments?.size ?? 0) > 0;
      const text = msg.content ?? "";
      const candidates = filterRunsByMessageShape(allRuns, hasAttachment, text);

      // Helper: dispatch chat fall-through if wired; otherwise count skipped.
      const dispatchChat = async (logTag: string): Promise<boolean> => {
        if (chatHandler === undefined) return false;
        try {
          const chatResult = chatHandler({
            channelId: msg.channelId,
            channelName: representativeChannelName,
            text,
            message: msg,
          });
          if (
            chatResult &&
            typeof (chatResult as Promise<void>).then === "function"
          ) {
            await (chatResult as Promise<void>);
          }
          return true;
        } catch (err: unknown) {
          console.error(
            `[catch-up] chatHandler threw while replaying message ${msg.id} (${logTag}) on ${representativeChannelName}:`,
            err,
          );
          return false;
        }
      };

      if (candidates.length === 0) {
        const ok = await dispatchChat(
          allRuns.length === 0
            ? "no active habit_run"
            : `no proof-shape match (${allRuns.length} active run(s))`,
        );
        if (ok) replayed += 1;
        else skipped += 1;
        continue;
      }

      if (candidates.length >= 2) {
        process.stdout.write(
          `[catch-up] ambiguous-proof: ${candidates.length} candidates match channel=${representativeChannelName} — falling through to chat handler for clarification\n`,
        );
        const ok = await dispatchChat(
          `ambiguous-proof (${candidates.length} candidates)`,
        );
        if (ok) replayed += 1;
        else skipped += 1;
        continue;
      }

      // candidates.length === 1
      const row = candidates[0] as ActiveHabitRun;
      const channelNameForRun = pickChannelNameForRun(
        sharedNames,
        row.habit_id,
      );
      const match: MessageMatch = {
        run: row,
        message: msg,
        channelName: channelNameForRun,
      };

      try {
        const result = handler(match);
        if (result && typeof (result as Promise<void>).then === "function") {
          await (result as Promise<void>);
        }
        replayed += 1;
      } catch (err: unknown) {
        console.error(
          `[catch-up] handler threw while replaying message ${msg.id} on ${channelNameForRun}:`,
          err,
        );
        // Count as skipped — the message was observed and the cursor advanced,
        // but no successful handler invocation occurred.
        skipped += 1;
      }
    }

    const entry: CatchUpChannelResult = {
      channelName,
      fetched,
      replayed,
      skipped,
    };
    perChannelByName.set(channelName, entry);
    results.push(entry);
  }

  return { perChannel: results };
}
