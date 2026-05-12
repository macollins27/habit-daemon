// Concept2 Logbook OAuth adapter.
//
// Task 9 (this commit) implements the one-time auth-setup flow:
//   - loadCredentials() — read & validate ~/.habit-daemon/concept2-credentials.json
//   - buildAuthorizationUrl() — construct the browser-side authorize URL
//   - exchangeCodeForTokens() — POST the authorization code, receive tokens
//   - saveTokens() — persist tokens to ~/.habit-daemon/concept2-tokens.json (0600)
//
// Task 10 will extend this module with authenticated results fetch
// (`fetchRowsBetween`) plus auto-refresh on 401 using the refresh_token. The
// fetch surface is intentionally absent here so that the auth flow can land,
// be reviewed, and be exercised end-to-end before the result-poll loop is built.
//
// Path resolution (`credentialsPath()` / `tokensPath()`) reads `os.homedir()`
// at call time rather than at module load. This keeps the module easy to test
// without env shims: callers (including the CLI) can override paths by
// passing them as parameters, and tests use `mkdtempSync` for isolation.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Concept2Credentials {
  readonly client_id: string;
  readonly client_secret: string;
  readonly redirect_uri: string;
}

export interface Concept2Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly token_type: "Bearer";
  readonly scope: string;
}

const AUTHORIZE_URL = "https://log.concept2.com/oauth/authorize";
const TOKEN_URL = "https://log.concept2.com/oauth/access_token";
const SCOPE = "user:read,results:read";

const CREDENTIALS_FILENAME = "concept2-credentials.json";
const TOKENS_FILENAME = "concept2-tokens.json";
const HABIT_DAEMON_DIR = ".habit-daemon";

export function credentialsPath(): string {
  return join(homedir(), HABIT_DAEMON_DIR, CREDENTIALS_FILENAME);
}

export function tokensPath(): string {
  return join(homedir(), HABIT_DAEMON_DIR, TOKENS_FILENAME);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function loadCredentials(path?: string): Concept2Credentials {
  const resolved = path ?? credentialsPath();

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Concept2 credentials file not found at ${resolved}: ${cause}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Concept2 credentials file at ${resolved} is malformed JSON: ${cause}`
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `Concept2 credentials file at ${resolved} must be a JSON object`
    );
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of ["client_id", "client_secret", "redirect_uri"] as const) {
    if (!isNonEmptyString(obj[key])) {
      throw new Error(
        `Concept2 credentials file at ${resolved} missing required string field: ${key}`
      );
    }
  }

  return {
    client_id: obj.client_id as string,
    client_secret: obj.client_secret as string,
    redirect_uri: obj.redirect_uri as string,
  };
}

export function saveTokens(tokens: Concept2Tokens, path?: string): void {
  const resolved = path ?? tokensPath();
  // The parent directory (~/.habit-daemon/ by default) is a credential
  // surface and must be restrictive. mkdirSync with recursive:true is a
  // no-op when the directory already exists. We do this BEFORE the
  // network exchange completes so a fresh-machine ENOENT cannot waste
  // the one-shot OAuth authorization code by failing the final write.
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const body = JSON.stringify(tokens, null, 2);
  writeFileSync(resolved, body, { encoding: "utf8", mode: 0o600 });
}

export function buildAuthorizationUrl(
  credentials: Concept2Credentials
): string {
  const params = new URLSearchParams({
    client_id: credentials.client_id,
    redirect_uri: credentials.redirect_uri,
    response_type: "code",
    scope: SCOPE,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface ExchangeOptions {
  readonly credentials: Concept2Credentials;
  readonly code: string;
  readonly fetchImpl?: typeof fetch;
}

export async function exchangeCodeForTokens(
  opts: ExchangeOptions
): Promise<Concept2Tokens> {
  const { credentials, code } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const body = new URLSearchParams({
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: credentials.redirect_uri,
  }).toString();

  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Concept2 token exchange failed: HTTP ${response.status}: ${errorBody}`
    );
  }

  const parsed = (await response.json()) as Record<string, unknown>;

  if (!isNonEmptyString(parsed.access_token)) {
    throw new Error("Concept2 token response missing access_token");
  }
  if (!isNonEmptyString(parsed.refresh_token)) {
    throw new Error("Concept2 token response missing refresh_token");
  }
  if (typeof parsed.expires_in !== "number" || !Number.isFinite(parsed.expires_in)) {
    throw new Error("Concept2 token response missing expires_in");
  }
  if (parsed.token_type !== "Bearer") {
    throw new Error(
      `Concept2 token response token_type must be Bearer, got ${String(parsed.token_type)}`
    );
  }
  if (!isNonEmptyString(parsed.scope)) {
    throw new Error("Concept2 token response missing scope field");
  }

  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_at: Date.now() + parsed.expires_in * 1000,
    token_type: "Bearer",
    scope: parsed.scope,
  };
}
