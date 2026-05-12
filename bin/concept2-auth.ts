#!/usr/bin/env -S npx tsx
// Concept2 OAuth one-time setup CLI.
//
// Usage:
//   tsx bin/concept2-auth.ts
//
// Reads ~/.habit-daemon/concept2-credentials.json (client_id, client_secret,
// redirect_uri), prints the authorization URL, waits for the user to paste
// the `code` query parameter from the post-auth redirect URL on stdin, then
// exchanges the code for tokens and writes them to
// ~/.habit-daemon/concept2-tokens.json (mode 0600).
//
// Exit codes:
//   0 — success
//   2 — credentials file missing or malformed
//   3 — token exchange failure (network or server)

import { createInterface } from "node:readline";
import {
  buildAuthorizationUrl,
  credentialsPath,
  exchangeCodeForTokens,
  loadCredentials,
  saveTokens,
  tokensPath,
  type Concept2Credentials,
} from "../src/lib/concept2-adapter.js";

function askCode(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question("code: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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

  const authUrl = buildAuthorizationUrl(credentials);
  process.stdout.write(
    [
      "Open this URL in your browser:",
      "",
      `  ${authUrl}`,
      "",
      "After authorizing, your browser will be redirected to:",
      `  ${credentials.redirect_uri}?code=XXX`,
      "",
      "Copy the value of the `code` query parameter and paste it below.",
      "",
      "",
    ].join("\n")
  );

  const code = await askCode();
  if (code.length === 0) {
    process.stderr.write("error: empty code\n");
    process.exit(2);
  }

  try {
    const tokens = await exchangeCodeForTokens({ credentials, code });
    saveTokens(tokens, tokPath);
    process.stdout.write(
      [
        `Saved tokens to ${tokPath}.`,
        `Access token expires at ${new Date(tokens.expires_at).toISOString()}.`,
        "",
      ].join("\n")
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(3);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
