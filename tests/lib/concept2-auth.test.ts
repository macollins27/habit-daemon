import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadCredentials,
  saveTokens,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  credentialsPath,
  tokensPath,
  type Concept2Credentials,
  type Concept2Tokens,
} from "../../src/lib/concept2-adapter.js";

const VALID_CREDS: Concept2Credentials = {
  client_id: "test-client-id",
  client_secret: "test-client-secret",
  redirect_uri: "http://localhost:8765/concept2/callback",
};

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeFetchMock(
  response: {
    ok: boolean;
    status?: number;
    body: unknown;
  },
  recorder: { last?: RecordedRequest }
): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const key of Object.keys(h)) {
        headers[key.toLowerCase()] = h[key];
      }
    }
    recorder.last = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 400),
      json: async () => response.body,
      text: async () =>
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body),
    } as Response;
  }) as typeof fetch;
}

describe("concept2-adapter paths", () => {
  it("credentialsPath() resolves under ~/.habit-daemon/", () => {
    const p = credentialsPath();
    expect(p.endsWith("/.habit-daemon/concept2-credentials.json")).toBe(true);
  });

  it("tokensPath() resolves under ~/.habit-daemon/", () => {
    const p = tokensPath();
    expect(p.endsWith("/.habit-daemon/concept2-tokens.json")).toBe(true);
  });
});

describe("loadCredentials()", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "concept2-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads valid JSON and returns a typed credentials object", () => {
    const p = join(dir, "creds.json");
    writeFileSync(p, JSON.stringify(VALID_CREDS), "utf8");

    const result = loadCredentials(p);

    expect(result).toEqual(VALID_CREDS);
  });

  it("throws a descriptive error when the file is missing", () => {
    const p = join(dir, "does-not-exist.json");
    expect(() => loadCredentials(p)).toThrow(
      /concept2-credentials|credentials|not found|ENOENT/i
    );
  });

  it("throws on malformed JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not valid json", "utf8");
    expect(() => loadCredentials(p)).toThrow();
  });

  it("throws when required keys are missing", () => {
    const p = join(dir, "missing.json");
    writeFileSync(
      p,
      JSON.stringify({ client_id: "x", client_secret: "y" }),
      "utf8"
    );
    expect(() => loadCredentials(p)).toThrow(/redirect_uri/);
  });

  it("throws when a required key is not a string", () => {
    const p = join(dir, "wrong-type.json");
    writeFileSync(
      p,
      JSON.stringify({
        client_id: 123,
        client_secret: "y",
        redirect_uri: "http://localhost/",
      }),
      "utf8"
    );
    expect(() => loadCredentials(p)).toThrow(/client_id/);
  });
});

describe("saveTokens()", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "concept2-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sample: Concept2Tokens = {
    access_token: "a",
    refresh_token: "r",
    expires_at: 1_715_520_000_000,
    token_type: "Bearer",
    scope: "user:read,results:read",
  };

  it("writes JSON that round-trips back to the same object", () => {
    const p = join(dir, "tokens.json");
    saveTokens(sample, p);

    const parsed = JSON.parse(readFileSync(p, "utf8")) as Concept2Tokens;
    expect(parsed).toEqual(sample);
  });

  it("writes the file with mode 0600", () => {
    const p = join(dir, "tokens.json");
    saveTokens(sample, p);

    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates missing parent directories with mode 0700", () => {
    const nestedPath = join(dir, "nested", "deeper", "tokens.json");

    expect(() => saveTokens(sample, nestedPath)).not.toThrow();

    const parsed = JSON.parse(
      readFileSync(nestedPath, "utf8")
    ) as Concept2Tokens;
    expect(parsed).toEqual(sample);

    const parentMode = statSync(join(dir, "nested", "deeper")).mode & 0o777;
    expect(parentMode).toBe(0o700);
  });
});

describe("buildAuthorizationUrl()", () => {
  it("returns a URL with the correct base and required query params", () => {
    const url = new URL(buildAuthorizationUrl(VALID_CREDS));

    expect(url.origin + url.pathname).toBe(
      "https://log.concept2.com/oauth/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe(VALID_CREDS.client_id);
    expect(url.searchParams.get("redirect_uri")).toBe(VALID_CREDS.redirect_uri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user:read,results:read");
  });

  it("URL-encodes special characters in redirect_uri", () => {
    const creds: Concept2Credentials = {
      ...VALID_CREDS,
      redirect_uri: "http://localhost:8765/concept2/callback?x=1 2",
    };
    const raw = buildAuthorizationUrl(creds);
    expect(raw).toContain("redirect_uri=");
    expect(raw).not.toContain("redirect_uri=http://localhost:8765/concept2/callback?x=1 2");

    const parsed = new URL(raw);
    expect(parsed.searchParams.get("redirect_uri")).toBe(creds.redirect_uri);
  });
});

describe("exchangeCodeForTokens()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("POSTs URL-encoded form body to the token endpoint with all 5 params", async () => {
    const recorder: { last?: RecordedRequest } = {};
    const fetchImpl = makeFetchMock(
      {
        ok: true,
        body: {
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "user:read,results:read",
        },
      },
      recorder
    );

    await exchangeCodeForTokens({
      credentials: VALID_CREDS,
      code: "AUTHCODE",
      fetchImpl,
    });

    expect(recorder.last).toBeDefined();
    expect(recorder.last!.url).toBe(
      "https://log.concept2.com/oauth/access_token"
    );
    expect(recorder.last!.method).toBe("POST");
    expect(recorder.last!.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    const params = new URLSearchParams(recorder.last!.body);
    expect(params.get("client_id")).toBe(VALID_CREDS.client_id);
    expect(params.get("client_secret")).toBe(VALID_CREDS.client_secret);
    expect(params.get("code")).toBe("AUTHCODE");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("redirect_uri")).toBe(VALID_CREDS.redirect_uri);
  });

  it("computes expires_at from expires_in seconds as epoch ms", async () => {
    const recorder: { last?: RecordedRequest } = {};
    const fetchImpl = makeFetchMock(
      {
        ok: true,
        body: {
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "user:read,results:read",
        },
      },
      recorder
    );

    const now = Date.now();
    const tokens = await exchangeCodeForTokens({
      credentials: VALID_CREDS,
      code: "X",
      fetchImpl,
    });

    expect(tokens.access_token).toBe("AT");
    expect(tokens.refresh_token).toBe("RT");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("user:read,results:read");
    expect(tokens.expires_at).toBe(now + 3600 * 1000);
  });

  it("throws when the response is not OK", async () => {
    const recorder: { last?: RecordedRequest } = {};
    const fetchImpl = makeFetchMock(
      { ok: false, status: 401, body: { error: "invalid_grant" } },
      recorder
    );

    await expect(
      exchangeCodeForTokens({
        credentials: VALID_CREDS,
        code: "BAD",
        fetchImpl,
      })
    ).rejects.toThrow(/401|invalid_grant|exchange|concept2/i);
  });

  it("throws when the response is missing access_token", async () => {
    const recorder: { last?: RecordedRequest } = {};
    const fetchImpl = makeFetchMock(
      {
        ok: true,
        body: {
          refresh_token: "RT",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "user:read,results:read",
        },
      },
      recorder
    );

    await expect(
      exchangeCodeForTokens({
        credentials: VALID_CREDS,
        code: "X",
        fetchImpl,
      })
    ).rejects.toThrow(/access_token/);
  });

  it("throws when the response is missing refresh_token", async () => {
    const recorder: { last?: RecordedRequest } = {};
    const fetchImpl = makeFetchMock(
      {
        ok: true,
        body: {
          access_token: "AT",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "user:read,results:read",
        },
      },
      recorder
    );

    await expect(
      exchangeCodeForTokens({
        credentials: VALID_CREDS,
        code: "X",
        fetchImpl,
      })
    ).rejects.toThrow(/refresh_token/);
  });

  it("throws when the response is missing expires_in", async () => {
    const recorder: { last?: RecordedRequest } = {};
    const fetchImpl = makeFetchMock(
      {
        ok: true,
        body: {
          access_token: "AT",
          refresh_token: "RT",
          token_type: "Bearer",
          scope: "user:read,results:read",
        },
      },
      recorder
    );

    await expect(
      exchangeCodeForTokens({
        credentials: VALID_CREDS,
        code: "X",
        fetchImpl,
      })
    ).rejects.toThrow(/expires_in/);
  });

  it("throws when the response is missing scope", async () => {
    const recorder: { last?: RecordedRequest } = {};
    const fetchImpl = makeFetchMock(
      {
        ok: true,
        body: {
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          token_type: "Bearer",
        },
      },
      recorder
    );

    await expect(
      exchangeCodeForTokens({
        credentials: VALID_CREDS,
        code: "X",
        fetchImpl,
      })
    ).rejects.toThrow(/scope/);
  });
});
