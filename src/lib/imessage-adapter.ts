/**
 * iMessage outbound transport — sends a text to a phone number via the macOS
 * Messages app, driven by `osascript` (AppleScript).
 *
 * Why iMessage and not Twilio: this is a single-user daemon that already runs
 * on the operator's Mac (launchd). Sending an iMessage from that Mac to the
 * operator's own number lands as a real text on their iPhone — with zero
 * third-party account, zero per-message cost, and none of Twilio's A2P 10DLC
 * registration latency. The trade-off is that this transport ONLY works when
 * the daemon runs on a macOS host with Messages.app signed into an Apple ID,
 * and the daemon process has been granted Automation permission to control
 * Messages (macOS TCC — the first send will prompt; for a launchd agent you
 * grant it once in System Settings → Privacy & Security → Automation, and/or
 * Full Disk Access). If the daemon ever moves to a Linux host, swap this
 * module for a Twilio adapter behind the same `sendText` contract.
 *
 * Security:
 *   - The message body is passed to osascript as an ARGV value bound to the
 *     AppleScript `run` handler — it is NEVER string-interpolated into the
 *     script source. That makes AppleScript injection from a crafted body
 *     impossible (the body cannot break out and execute arbitrary AppleScript).
 *   - Phone numbers are masked in any caller-facing error text via
 *     `maskPhone` so logs never carry the full number.
 *
 * Testability: the actual subprocess call is injected via `deps.runner`.
 * Production callers leave it unset and get the real `osascript` execFile
 * runner; tests pass a fake so they never spawn a process or send a text.
 */

import { execFile } from "node:child_process";

/**
 * AppleScript that sends `targetBody` to `targetPhone` over the first
 * iMessage-typed service. Authored as an `on run {…}` handler so both the
 * phone and the body arrive as bound arguments (see Security note above) —
 * the body is data, never code.
 */
const OSASCRIPT_SOURCE = [
  "on run {targetPhone, targetBody}",
  '\ttell application "Messages"',
  "\t\tset targetService to 1st service whose service type = iMessage",
  "\t\tset targetBuddy to buddy targetPhone of targetService",
  "\t\tsend targetBody to targetBuddy",
  "\tend tell",
  "end run",
].join("\n");

export interface SendTextOptions {
  /** Destination phone number, E.164 form (e.g. "+18135551234"). */
  readonly to: string;
  /** Message body. Passed as an osascript argv value, never interpolated. */
  readonly body: string;
}

export interface SendTextResult {
  readonly ok: boolean;
  /** Populated (and phone-masked) only when `ok === false`. */
  readonly error?: string;
}

/** Outcome of a single osascript invocation. */
export interface OsascriptOutcome {
  readonly code: number;
  readonly stderr: string;
}

/**
 * Subprocess seam. Receives the full osascript argv (including the leading
 * `-e <script>` and the trailing phone/body args) and resolves with the exit
 * code + stderr. Never rejects in the production impl — failures surface as a
 * non-zero `code`.
 */
export type OsascriptRunner = (args: readonly string[]) => Promise<OsascriptOutcome>;

export interface ImessageDeps {
  /** Test seam. Production callers leave this unset. */
  readonly runner?: OsascriptRunner;
}

/**
 * Build the exact argv passed to `osascript`. Pure + exported so a test can
 * prove the body is bound as an argument (args[3]) rather than spliced into
 * the script source (OSASCRIPT_SOURCE never contains the body).
 */
export function buildOsascriptArgs(to: string, body: string): readonly string[] {
  return ["-e", OSASCRIPT_SOURCE, to, body];
}

/**
 * Mask a phone number for logs/errors: keep only the last 4 digits, replace
 * everything before them with a fixed marker. "+18135551234" → "•••••••1234".
 * A short/empty value is fully masked.
 */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return "•".repeat(phone.length);
  const last4 = phone.slice(-4);
  return "•".repeat(phone.length - 4) + last4;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const defaultRunner: OsascriptRunner = (args) =>
  new Promise<OsascriptOutcome>((resolveOutcome) => {
    execFile(
      "osascript",
      [...args],
      { timeout: DEFAULT_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (err) {
          const code =
            typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : 1;
          resolveOutcome({ code, stderr: stderr || err.message });
        } else {
          resolveOutcome({ code: 0, stderr: stderr ?? "" });
        }
      },
    );
  });

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

/**
 * Send a text via iMessage. Fail-closed and non-throwing: every failure path
 * (invalid input, non-zero exit, runner exception) returns
 * `{ ok: false, error }` with the phone number masked, so the escalation loop
 * can record the attempt without leaking the number or crashing the tick.
 */
export async function sendText(
  opts: SendTextOptions,
  deps: ImessageDeps = {},
): Promise<SendTextResult> {
  const { to, body } = opts;

  if (typeof to !== "string" || to.length === 0) {
    return { ok: false, error: "iMessage send: destination number is empty" };
  }
  if (typeof body !== "string" || body.length === 0) {
    return {
      ok: false,
      error: `iMessage send to ${maskPhone(to)}: body is empty`,
    };
  }

  const runner = deps.runner ?? defaultRunner;
  const args = buildOsascriptArgs(to, body);

  try {
    const { code, stderr } = await runner(args);
    if (code !== 0) {
      return {
        ok: false,
        error: `iMessage send to ${maskPhone(to)} failed: osascript exited ${String(
          code,
        )}: ${stderr.slice(0, 300)}`,
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    return {
      ok: false,
      error: `iMessage send to ${maskPhone(to)} threw: ${getErrorMessage(error)}`,
    };
  }
}
