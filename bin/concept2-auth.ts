#!/usr/bin/env -S npx tsx
// Concept2 OAuth one-time setup CLI.
//
// Usage:
//   pnpm exec tsx bin/concept2-auth.ts
//
// Reads ~/.habit-daemon/concept2-credentials.json (client_id, client_secret,
// redirect_uri). If the registered redirect_uri is a localhost URL the helper
// runs an automated flow: it binds an HTTP listener on that exact host+port,
// opens the authorize URL in the default browser, captures the `code` query
// param on the callback, exchanges it for tokens, and writes
// ~/.habit-daemon/concept2-tokens.json (mode 0600). The browser receives a
// short "you can close this tab" page. The script exits 0 on success.
//
// If the registered redirect_uri is NOT localhost (e.g., a custom domain or
// OOB), the helper falls back to a manual-paste flow.
//
// Exit codes:
//   0 — success
//   2 — credentials file missing or malformed
//   3 — token exchange failure (network or server)
//   4 — user denied or callback timed out
//   5 — local port already in use

import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import {
  buildAuthorizationUrl,
  credentialsPath,
  exchangeCodeForTokens,
  loadCredentials,
  saveTokens,
  tokensPath,
  type Concept2Credentials,
  type Concept2Tokens,
} from "../src/lib/concept2-adapter.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface CallbackResult {
  readonly code: string;
}

interface ParsedRedirect {
  readonly host: string;
  readonly port: number;
  readonly path: string;
}

function parseRedirectUri(redirectUri: string): ParsedRedirect | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : 80;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { host: url.hostname, port, path: url.pathname || "/" };
}

function openInBrowser(url: string): void {
  // macOS `open` returns immediately; we don't wait on it. If it fails
  // (no GUI available) the user can still paste the URL manually.
  const child = spawn("open", [url], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", () => {
    // Swallow — the URL is also printed to stdout for manual fallback.
  });
}

async function captureCodeViaLocalhostCallback(
  redirect: ParsedRedirect,
): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${redirect.host}:${redirect.port}`);
      if (url.pathname !== redirect.path) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error !== null) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h1>Authorization denied</h1><p>Concept2 reported: ${error}. You can close this tab and re-run bin/concept2-auth.ts.</p></body></html>`,
        );
        finish(() => {
          server.close();
          reject(new Error(`OAuth denied: ${error}`));
        });
        return;
      }
      if (code === null || code.length === 0) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing code");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Concept2 authorized</h1><p>Tokens captured. You can close this tab.</p></body></html>",
      );
      finish(() => {
        server.close();
        resolve({ code });
      });
    });

    const timer = setTimeout(() => {
      finish(() => {
        server.close();
        reject(new Error("Timed out waiting for OAuth callback (5 minutes)"));
      });
    }, CALLBACK_TIMEOUT_MS);
    timer.unref();

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finish(() => {
          reject(
            new Error(
              `Port ${String(redirect.port)} on ${redirect.host} already in use. ` +
                `Stop the conflicting process and re-run, or change the registered ` +
                `redirect_uri on the Concept2 developer console.`,
            ),
          );
        });
        return;
      }
      finish(() => {
        reject(err);
      });
    });

    server.listen(redirect.port, redirect.host);
  });
}

async function askCodeFromStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question("code: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runLocalhostFlow(
  credentials: Concept2Credentials,
  redirect: ParsedRedirect,
): Promise<string> {
  const authUrl = buildAuthorizationUrl(credentials);
  process.stdout.write(
    [
      "Concept2 OAuth one-time setup",
      "",
      `Listening for callback on http://${redirect.host}:${String(redirect.port)}${redirect.path}`,
      "Opening browser to:",
      `  ${authUrl}`,
      "",
      "If the browser does not open, paste the URL above into a browser manually.",
      "After authorizing, you can close the tab.",
      "",
    ].join("\n"),
  );
  openInBrowser(authUrl);
  const result = await captureCodeViaLocalhostCallback(redirect);
  return result.code;
}

async function runManualPasteFlow(credentials: Concept2Credentials): Promise<string> {
  const authUrl = buildAuthorizationUrl(credentials);
  process.stdout.write(
    [
      "Concept2 OAuth one-time setup (manual paste mode)",
      "",
      "Open this URL in your browser:",
      `  ${authUrl}`,
      "",
      "After authorizing, copy the `code` query parameter from the redirect URL.",
      "",
    ].join("\n"),
  );
  const code = await askCodeFromStdin();
  if (code.length === 0) {
    throw new Error("empty code");
  }
  return code;
}

async function main(): Promise<void> {
  const credPath = credentialsPath();
  const tokPath = tokensPath();

  let credentials: Concept2Credentials;
  try {
    credentials = loadCredentials(credPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(2);
  }

  let code: string;
  const redirect = parseRedirectUri(credentials.redirect_uri);
  try {
    code = redirect !== null
      ? await runLocalhostFlow(credentials, redirect)
      : await runManualPasteFlow(credentials);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(msg.includes("already in use") ? 5 : 4);
  }

  let tokens: Concept2Tokens;
  try {
    tokens = await exchangeCodeForTokens({ credentials, code });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(3);
  }

  saveTokens(tokens, tokPath);
  process.stdout.write(
    [
      `Saved tokens to ${tokPath}.`,
      `Access token expires at ${new Date(tokens.expires_at).toISOString()}.`,
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
