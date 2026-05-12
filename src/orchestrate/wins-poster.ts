// Task 23: #wins channel auto-post on completion.
//
// `postWin()` is the orchestration verb invoked when `habit_runs.status`
// transitions to `completed`. It composes a one-line factual record per
// habit type (bare facts, no qualifiers, no annotations — see design § 5)
// and posts it to the bot-output-only #wins channel via the Task 21
// `postToChannel` outbound poster.
//
// Decoupling contract:
//   - The verb is a pure composer + poster. It does NOT query the database,
//     does NOT decide when a transition occurred, and does NOT mutate
//     habit_runs. The caller (a future habit-checkin or sensor-resolution
//     orchestrator) is responsible for assembling the `Completion` payload
//     from already-validated sources (PM5 row, lift log, Garmin asleep
//     onset) and supplying the `status` it has just written.
//   - Every status that is not the literal string `completed` is a no-op.
//     This is the same guard the design specifies for the #wins channel:
//     "All `status = completed` rows post identically. ... Moralizing
//     narrow wins violates the same no-moralizing constraint as moralizing
//     misses." — design § 5.
//
// Formatting rules (verbatim from design § 5):
//
//   row:       ✓ Morning row · 9:42 · 12 min · 2,143m
//   strength:  ✓ Strength · Wed 7:08pm · 4 lifts logged
//   wind-down: ✓ Wind-down · stage A 22:08 · Garmin asleep 22:55
//
// Unicode characters used in source:
//   ✓ — U+2713 (CHECK MARK). This is the ONE emoji allowed in source per
//       the project's no-emoji rule because it is a functional UI label
//       for the #wins channel, not decoration.
//   · — U+00B7 (MIDDLE DOT). Field separator.
//
// `toLocaleString('en-US')` is used for the meters value so the en-US
// thousand-separator behaviour is deterministic across operating systems
// (Node bundles the en-US locale data in the small-icu build by default).
//
// References:
//   - docs/plans/2026-05-12-habit-daemon-design.md § 5 (#wins format)
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 23
//   - src/lib/discord-adapter.ts (postToChannel — outbound write path)

import {
  postToChannel,
  type DiscordAdapter,
} from "../lib/discord-adapter.js";

export interface RowCompletion {
  readonly habit: "morning-row";
  readonly time: string; // "9:42" — pre-formatted by caller
  readonly durationMinutes: number; // 12
  readonly meters: number; // 2143
}

export interface StrengthCompletion {
  readonly habit: "strength-mwf";
  readonly time: string; // "Wed 7:08pm" — pre-formatted by caller
  readonly liftCount: number; // 4
}

export interface WindDownCompletion {
  readonly habit: "wind-down";
  readonly stageATime: string; // "22:08"
  readonly garminAsleepTime: string; // "22:55"
}

export type Completion =
  | RowCompletion
  | StrengthCompletion
  | WindDownCompletion;

export interface PostWinOptions {
  readonly adapter: DiscordAdapter;
  readonly status: string; // typically habit_runs.status
  readonly completion: Completion;
}

export interface PostWinResult {
  readonly posted: boolean;
  readonly messageId?: string;
}

// The only status that triggers a #wins post. Every other documented
// status (missed, skipped, unresolved, partial, pending,
// unresolved_no_data) is a no-op.
const COMPLETED_STATUS = "completed";

export function formatWin(completion: Completion): string {
  switch (completion.habit) {
    case "morning-row": {
      const meters = completion.meters.toLocaleString("en-US");
      return `✓ Morning row · ${completion.time} · ${completion.durationMinutes} min · ${meters}m`;
    }
    case "strength-mwf": {
      return `✓ Strength · ${completion.time} · ${completion.liftCount} lifts logged`;
    }
    case "wind-down": {
      return `✓ Wind-down · stage A ${completion.stageATime} · Garmin asleep ${completion.garminAsleepTime}`;
    }
    default: {
      // Exhaustiveness check — if a new variant is added to the union and
      // the switch isn't updated, TypeScript fails at the assignment to
      // `_exhaustive`. Throwing at runtime is the belt-and-braces guard for
      // any caller that bypasses typing.
      const _exhaustive: never = completion;
      throw new Error(
        `Unknown completion habit: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

export async function postWin(opts: PostWinOptions): Promise<PostWinResult> {
  if (opts.status !== COMPLETED_STATUS) {
    return { posted: false };
  }

  const content = formatWin(opts.completion);

  const result = await postToChannel({
    adapter: opts.adapter,
    channel: "wins",
    content,
  });

  return { posted: true, messageId: result.messageId };
}
