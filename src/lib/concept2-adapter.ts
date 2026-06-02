// Concept2 Logbook OAuth + results-fetch adapter.
//
// Task 9 added the one-time auth-setup flow:
//   - loadCredentials() — read & validate ~/.habit-daemon/concept2-credentials.json
//   - buildAuthorizationUrl() — construct the browser-side authorize URL
//   - exchangeCodeForTokens() — POST the authorization code, receive tokens
//   - saveTokens() — persist tokens to ~/.habit-daemon/concept2-tokens.json (0600)
//
// Task 10 (this commit) extends the module with authenticated results fetch:
//   - fetchRowsBetween() — GET /api/users/me/results?from=&to=, with
//     transparent 401-driven refresh + retry, and links.next pagination.
//   - refreshTokens() — POST /oauth/access_token with grant_type=refresh_token.
//
// The fetch path takes an optional onTokensRefreshed callback so the caller
// (the daemon) can persist newly-minted tokens to disk without this module
// needing to know where they live. saveTokens() remains the single writer.
//
// Path resolution (`credentialsPath()` / `tokensPath()`) reads `os.homedir()`
// at call time rather than at module load. This keeps the module easy to test
// without env shims: callers (including the CLI) can override paths by
// passing them as parameters, and tests use `mkdtempSync` for isolation.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";

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
const RESULTS_URL = "https://log.concept2.com/api/users/me/results";
const SCOPE = "user:read,results:read";

// Defensive cap on pagination chases. A typical daemon poll window is ~1 day,
// and Concept2's default page size is 50, so a real-world response will fit in
// 1–2 pages. Anything beyond MAX_PAGES indicates an upstream bug or a bad
// `links.next` loop, and we throw rather than spin forever.
const MAX_PAGES = 100;

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

// Shared validator for the Concept2 token endpoint, used by both the
// initial authorization-code exchange and the refresh_token grant. All five
// fields (access_token, refresh_token, expires_in, token_type, scope) are
// required so the daemon never persists a half-formed token record.
function parseTokenResponse(parsed: Record<string, unknown>): Concept2Tokens {
  if (!isNonEmptyString(parsed.access_token)) {
    throw new Error("Concept2 token response missing access_token");
  }
  if (!isNonEmptyString(parsed.refresh_token)) {
    throw new Error("Concept2 token response missing refresh_token");
  }
  if (
    typeof parsed.expires_in !== "number" ||
    !Number.isFinite(parsed.expires_in)
  ) {
    throw new Error("Concept2 token response missing expires_in");
  }
  if (parsed.token_type !== "Bearer") {
    throw new Error(
      `Concept2 token response token_type must be Bearer, got ${String(parsed.token_type)}`
    );
  }
  // OAuth 2.0 (RFC 6749 §5.1): the `scope` response field is REQUIRED only
  // if the granted scope differs from the requested scope. Concept2 omits
  // it when the grant matches, so we default to the scope we asked for.
  const scope = isNonEmptyString(parsed.scope) ? parsed.scope : SCOPE;
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_at: Date.now() + parsed.expires_in * 1000,
    token_type: "Bearer",
    scope,
  };
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
  return parseTokenResponse(parsed);
}

export interface RefreshOptions {
  readonly credentials: Concept2Credentials;
  readonly refreshToken: string;
  readonly fetchImpl?: typeof fetch;
}

export async function refreshTokens(
  opts: RefreshOptions
): Promise<Concept2Tokens> {
  const { credentials, refreshToken } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
  }).toString();

  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Concept2 token refresh failed: HTTP ${response.status}: ${errorBody}`
    );
  }

  const parsed = (await response.json()) as Record<string, unknown>;
  return parseTokenResponse(parsed);
}

export interface Concept2Result {
  readonly id: number;
  readonly date: string;
  readonly type: string;
  readonly duration_seconds: number;
  readonly distance_meters: number;
}

export interface FetchRowsOptions {
  readonly from: Date;
  readonly to: Date;
  readonly credentials: Concept2Credentials;
  readonly tokens: Concept2Tokens;
  readonly fetchImpl?: typeof fetch;
  readonly onTokensRefreshed?: (newTokens: Concept2Tokens) => void;
}

// Format a Date as YYYY-MM-DD in UTC. Concept2's API takes a date-only
// `from`/`to` rather than a full ISO timestamp; the daemon polls with
// roughly local-noon windows, so a naive UTC truncation is fine.
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Issue a single authenticated GET. On 401, refresh tokens once and retry.
// Returns the parsed JSON object on success, throws on terminal failure.
// `tokensRef` is mutable-by-reassignment so the caller can pick up refreshed
// access_tokens for any subsequent pagination requests.
async function getWithAuthRetry(
  url: string,
  tokensRef: { current: Concept2Tokens },
  credentials: Concept2Credentials,
  fetchImpl: typeof fetch,
  onTokensRefreshed: ((newTokens: Concept2Tokens) => void) | undefined
): Promise<Record<string, unknown>> {
  const initial = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${tokensRef.current.access_token}` },
  });

  if (initial.status !== 401) {
    if (!initial.ok) {
      const errorBody = await initial.text().catch(() => "");
      throw new Error(
        `Concept2 results fetch failed: HTTP ${initial.status}: ${errorBody}`
      );
    }
    return (await initial.json()) as Record<string, unknown>;
  }

  // 401: refresh once, then retry once.
  const refreshed = await refreshTokens({
    credentials,
    refreshToken: tokensRef.current.refresh_token,
    fetchImpl,
  });
  tokensRef.current = refreshed;
  onTokensRefreshed?.(refreshed);

  const retry = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${refreshed.access_token}` },
  });

  if (!retry.ok) {
    const errorBody = await retry.text().catch(() => "");
    throw new Error(
      `Concept2 results fetch failed after refresh: HTTP ${retry.status}: ${errorBody}`
    );
  }
  return (await retry.json()) as Record<string, unknown>;
}

export async function fetchRowsBetween(
  opts: FetchRowsOptions
): Promise<readonly Concept2Result[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tokensRef = { current: opts.tokens };

  const initialUrl = (() => {
    const params = new URLSearchParams({
      from: toIsoDate(opts.from),
      to: toIsoDate(opts.to),
    });
    return `${RESULTS_URL}?${params.toString()}`;
  })();

  const allRows: Concept2Result[] = [];
  let nextUrl: string | null = initialUrl;
  let pageCount = 0;

  while (nextUrl !== null) {
    if (pageCount >= MAX_PAGES) {
      throw new Error(
        `Concept2 pagination exceeded ${MAX_PAGES} pages, likely a bug`
      );
    }
    pageCount += 1;

    const parsed = await getWithAuthRetry(
      nextUrl,
      tokensRef,
      opts.credentials,
      fetchImpl,
      opts.onTokensRefreshed
    );

    if (!Array.isArray(parsed.data)) {
      throw new Error("Concept2 results response missing data array");
    }
    for (const rawRow of parsed.data) {
      // Concept2 API returns raw fields named `time` (in deciseconds —
      // tenths of a second, per their API docs) and `distance` (in meters).
      // Our internal Concept2Result type uses `duration_seconds` and
      // `distance_meters` so downstream code (findQualifyingSession, the
      // prompt-builder, the proof verifier) doesn't have to know about the
      // wire format. Transform here once at the API boundary.
      //
      // Defensive: if the row already carries the internal field names
      // (older cached payloads, fixture data), prefer those — the
      // transformation is a one-way upgrade.
      const r = rawRow as Record<string, unknown>;
      const durationSec =
        typeof r.duration_seconds === "number"
          ? r.duration_seconds
          : typeof r.time === "number"
            ? r.time / 10
            : 0;
      const distanceM =
        typeof r.distance_meters === "number"
          ? r.distance_meters
          : typeof r.distance === "number"
            ? r.distance
            : 0;
      allRows.push({
        id: typeof r.id === "number" ? r.id : 0,
        date: typeof r.date === "string" ? r.date : "",
        type: typeof r.type === "string" ? r.type : "",
        duration_seconds: durationSec,
        distance_meters: distanceM,
      });
    }

    const links = parsed.links;
    if (
      typeof links === "object" &&
      links !== null &&
      isNonEmptyString((links as Record<string, unknown>).next)
    ) {
      nextUrl = (links as Record<string, unknown>).next as string;
    } else {
      nextUrl = null;
    }
  }

  return allRows;
}

// Task 11: cache one day's Concept2 results into the sensor_signals table.
//
// The daemon polls Concept2 on a recurring schedule (Task 16 wires it up).
// Each poll fetches the day's results and persists them as a single
// sensor_signals row keyed by (source='concept2', payload_date=YYYY-MM-DD).
// The deterministic id `concept2-YYYY-MM-DD` makes the row idempotently
// queryable from feature builders without a secondary index.
//
// The payload is wrapped as `{results: [...]}` rather than a bare array so
// future schema additions (e.g., fetch metadata, sync source markers) can be
// added without breaking parsers that already read the `results` field.
export interface SyncDateOptions {
  readonly db: Database.Database;
  readonly date: Date;
  readonly credentials: Concept2Credentials;
  readonly tokens: Concept2Tokens;
  readonly fetchImpl?: typeof fetch;
  readonly onTokensRefreshed?: (newTokens: Concept2Tokens) => void;
}

export async function syncDate(opts: SyncDateOptions): Promise<void> {
  const payloadDate = toIsoDate(opts.date);

  const results = await fetchRowsBetween({
    from: opts.date,
    to: opts.date,
    credentials: opts.credentials,
    tokens: opts.tokens,
    fetchImpl: opts.fetchImpl,
    onTokensRefreshed: opts.onTokensRefreshed,
  });

  const id = `concept2-${payloadDate}`;
  const payloadJson = JSON.stringify({ results });
  const fetchedAt = Date.now();

  opts.db
    .prepare(
      `INSERT OR REPLACE INTO sensor_signals (
        id, source, payload_date, payload_json, fetched_at
      ) VALUES (?, 'concept2', ?, ?, ?)`
    )
    .run(id, payloadDate, payloadJson, fetchedAt);
}
