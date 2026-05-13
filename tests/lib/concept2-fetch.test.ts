import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchRowsBetween,
  refreshTokens,
  type Concept2Credentials,
  type Concept2Tokens,
  type Concept2Result,
} from "../../src/lib/concept2-adapter.js";

const VALID_CREDS: Concept2Credentials = {
  client_id: "test-client-id",
  client_secret: "test-client-secret",
  redirect_uri: "http://localhost:8765/concept2/callback",
};

const VALID_TOKENS: Concept2Tokens = {
  access_token: "AT-original",
  refresh_token: "RT-original",
  expires_at: 1_715_520_000_000,
  token_type: "Bearer",
  scope: "user:read,results:read",
};

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface CannedResponse {
  ok: boolean;
  status?: number;
  body: unknown;
}

function makeMultiFetchMock(
  responses: readonly CannedResponse[],
  recorder: { calls: RecordedRequest[] }
): typeof fetch {
  let index = 0;
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
    recorder.calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (index >= responses.length) {
      throw new Error(
        `fetch mock exhausted: call #${index + 1} but only ${responses.length} canned responses`
      );
    }
    const response = responses[index++];
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

const SAMPLE_ROW_A: Concept2Result = {
  id: 100,
  date: "2026-05-12 09:15:00",
  type: "rower",
  duration_seconds: 720,
  distance_meters: 2143,
};

const SAMPLE_ROW_B: Concept2Result = {
  id: 101,
  date: "2026-05-12 18:00:00",
  type: "rower",
  duration_seconds: 600,
  distance_meters: 1800,
};

const SAMPLE_ROW_C: Concept2Result = {
  id: 102,
  date: "2026-05-12 21:30:00",
  type: "rower",
  duration_seconds: 540,
  distance_meters: 1600,
};

describe("fetchRowsBetween() happy path", () => {
  it("GETs the results endpoint with from/to in YYYY-MM-DD format and Bearer auth", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            data: [SAMPLE_ROW_A, SAMPLE_ROW_B],
            meta: { total_count: 2 },
            links: { first: "...", next: null, prev: null, last: "..." },
          },
        },
      ],
      recorder
    );

    const results = await fetchRowsBetween({
      from: new Date("2026-05-12T08:00:00Z"),
      to: new Date("2026-05-12T23:59:59Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
    });

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call.method).toBe("GET");
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(
      "https://log.concept2.com/api/users/me/results"
    );
    expect(url.searchParams.get("from")).toBe("2026-05-12");
    expect(url.searchParams.get("to")).toBe("2026-05-12");
    expect(call.headers["authorization"]).toBe("Bearer AT-original");

    expect(results).toEqual([SAMPLE_ROW_A, SAMPLE_ROW_B]);
  });

  it("returns an empty array when the API returns no rows", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [{ ok: true, body: { data: [], links: { next: null } } }],
      recorder
    );

    const results = await fetchRowsBetween({
      from: new Date("2026-05-12T00:00:00Z"),
      to: new Date("2026-05-12T23:59:59Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
    });

    expect(results).toEqual([]);
  });
});

describe("fetchRowsBetween() 401 + refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("on 401, refreshes tokens and retries the GET once, invoking onTokensRefreshed", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        // 1) initial GET → 401
        { ok: false, status: 401, body: { error: "expired" } },
        // 2) refresh POST → 200 with new tokens
        {
          ok: true,
          body: {
            access_token: "AT-new",
            refresh_token: "RT-new",
            expires_in: 7200,
            token_type: "Bearer",
            scope: "user:read,results:read",
          },
        },
        // 3) retry GET → 200 with data
        {
          ok: true,
          body: { data: [SAMPLE_ROW_A], links: { next: null } },
        },
      ],
      recorder
    );

    const refreshed: Concept2Tokens[] = [];
    const results = await fetchRowsBetween({
      from: new Date("2026-05-12T00:00:00Z"),
      to: new Date("2026-05-12T23:59:59Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
      onTokensRefreshed: (t) => refreshed.push(t),
    });

    expect(recorder.calls).toHaveLength(3);

    // call 1: initial GET with stale Authorization
    expect(recorder.calls[0].method).toBe("GET");
    expect(recorder.calls[0].headers["authorization"]).toBe("Bearer AT-original");

    // call 2: refresh POST to token endpoint
    expect(recorder.calls[1].method).toBe("POST");
    expect(recorder.calls[1].url).toBe(
      "https://log.concept2.com/oauth/access_token"
    );
    const refreshBody = new URLSearchParams(recorder.calls[1].body);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("RT-original");
    expect(refreshBody.get("client_id")).toBe(VALID_CREDS.client_id);
    expect(refreshBody.get("client_secret")).toBe(VALID_CREDS.client_secret);

    // call 3: retry GET with NEW Authorization
    expect(recorder.calls[2].method).toBe("GET");
    expect(recorder.calls[2].headers["authorization"]).toBe("Bearer AT-new");

    // callback invoked with the new tokens
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].access_token).toBe("AT-new");
    expect(refreshed[0].refresh_token).toBe("RT-new");
    expect(refreshed[0].expires_at).toBe(Date.now() + 7200 * 1000);

    // final data
    expect(results).toEqual([SAMPLE_ROW_A]);
  });

  it("throws when the retry GET also returns 401", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        { ok: false, status: 401, body: { error: "expired" } },
        {
          ok: true,
          body: {
            access_token: "AT-new",
            refresh_token: "RT-new",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "user:read,results:read",
          },
        },
        { ok: false, status: 401, body: { error: "still bad" } },
      ],
      recorder
    );

    await expect(
      fetchRowsBetween({
        from: new Date("2026-05-12T00:00:00Z"),
        to: new Date("2026-05-12T23:59:59Z"),
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        fetchImpl,
      })
    ).rejects.toThrow(/401|unauthorized|concept2/i);

    // Three calls: initial, refresh, retry. No further attempts.
    expect(recorder.calls).toHaveLength(3);
  });
});

describe("fetchRowsBetween() pagination", () => {
  it("follows links.next until null, concatenating results from all pages", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            data: [SAMPLE_ROW_A, SAMPLE_ROW_B],
            links: {
              next: "https://log.concept2.com/api/users/me/results?from=2026-05-12&to=2026-05-12&page=2",
            },
          },
        },
        {
          ok: true,
          body: {
            data: [SAMPLE_ROW_C],
            links: { next: null },
          },
        },
      ],
      recorder
    );

    const results = await fetchRowsBetween({
      from: new Date("2026-05-12T00:00:00Z"),
      to: new Date("2026-05-12T23:59:59Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
    });

    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[1].url).toBe(
      "https://log.concept2.com/api/users/me/results?from=2026-05-12&to=2026-05-12&page=2"
    );
    expect(recorder.calls[1].headers["authorization"]).toBe(
      "Bearer AT-original"
    );

    expect(results).toEqual([SAMPLE_ROW_A, SAMPLE_ROW_B, SAMPLE_ROW_C]);
  });

  it("throws if pagination exceeds the defensive cap", async () => {
    // Build a fetch that always returns a next link, never terminating.
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl: typeof fetch = (async (
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
      recorder.calls.push({
        url,
        method: init?.method ?? "GET",
        headers,
        body: "",
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [SAMPLE_ROW_A],
          links: {
            next: "https://log.concept2.com/api/users/me/results?page=loop",
          },
        }),
        text: async () => "",
      } as Response;
    }) as typeof fetch;

    await expect(
      fetchRowsBetween({
        from: new Date("2026-05-12T00:00:00Z"),
        to: new Date("2026-05-12T23:59:59Z"),
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        fetchImpl,
      })
    ).rejects.toThrow(/pagination/i);
  });
});

describe("fetchRowsBetween() error responses", () => {
  it("throws a descriptive error on non-OK status (500)", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [{ ok: false, status: 500, body: "internal server error" }],
      recorder
    );

    await expect(
      fetchRowsBetween({
        from: new Date("2026-05-12T00:00:00Z"),
        to: new Date("2026-05-12T23:59:59Z"),
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        fetchImpl,
      })
    ).rejects.toThrow(/500|concept2|results/i);
  });

  it("throws when the response body is not a JSON object with a data array", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [{ ok: true, body: { not_data: "oops" } }],
      recorder
    );

    await expect(
      fetchRowsBetween({
        from: new Date("2026-05-12T00:00:00Z"),
        to: new Date("2026-05-12T23:59:59Z"),
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        fetchImpl,
      })
    ).rejects.toThrow(/data|array|concept2/i);
  });
});

describe("refreshTokens()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("POSTs URL-encoded form with grant_type=refresh_token and all required params", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            access_token: "AT-new",
            refresh_token: "RT-new",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "user:read,results:read",
          },
        },
      ],
      recorder
    );

    const tokens = await refreshTokens({
      credentials: VALID_CREDS,
      refreshToken: "RT-original",
      fetchImpl,
    });

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call.url).toBe("https://log.concept2.com/oauth/access_token");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    );

    const params = new URLSearchParams(call.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("RT-original");
    expect(params.get("client_id")).toBe(VALID_CREDS.client_id);
    expect(params.get("client_secret")).toBe(VALID_CREDS.client_secret);

    expect(tokens.access_token).toBe("AT-new");
    expect(tokens.refresh_token).toBe("RT-new");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("user:read,results:read");
    expect(tokens.expires_at).toBe(Date.now() + 3600 * 1000);
  });

  it("throws on non-OK status", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [{ ok: false, status: 400, body: { error: "invalid_grant" } }],
      recorder
    );

    await expect(
      refreshTokens({
        credentials: VALID_CREDS,
        refreshToken: "bad",
        fetchImpl,
      })
    ).rejects.toThrow(/400|invalid_grant|refresh|concept2/i);
  });

  it("throws when the response is missing access_token", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            refresh_token: "RT-new",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "user:read,results:read",
          },
        },
      ],
      recorder
    );

    await expect(
      refreshTokens({
        credentials: VALID_CREDS,
        refreshToken: "RT-original",
        fetchImpl,
      })
    ).rejects.toThrow(/access_token/);
  });

  it("throws when the response is missing refresh_token", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            access_token: "AT-new",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "user:read,results:read",
          },
        },
      ],
      recorder
    );

    await expect(
      refreshTokens({
        credentials: VALID_CREDS,
        refreshToken: "RT-original",
        fetchImpl,
      })
    ).rejects.toThrow(/refresh_token/);
  });

  it("throws when the response is missing expires_in", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            access_token: "AT-new",
            refresh_token: "RT-new",
            token_type: "Bearer",
            scope: "user:read,results:read",
          },
        },
      ],
      recorder
    );

    await expect(
      refreshTokens({
        credentials: VALID_CREDS,
        refreshToken: "RT-original",
        fetchImpl,
      })
    ).rejects.toThrow(/expires_in/);
  });

  it("defaults scope to the requested value when the response omits it", async () => {
    // RFC 6749 §5.1 — see exchangeCodeForTokens counterpart for context.
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            access_token: "AT-new",
            refresh_token: "RT-new",
            expires_in: 3600,
            token_type: "Bearer",
          },
        },
      ],
      recorder
    );

    const tokens = await refreshTokens({
      credentials: VALID_CREDS,
      refreshToken: "RT-original",
      fetchImpl,
    });
    expect(tokens.scope).toBe("user:read,results:read");
  });

  it("throws when token_type is not Bearer", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            access_token: "AT-new",
            refresh_token: "RT-new",
            expires_in: 3600,
            token_type: "Mac",
            scope: "user:read,results:read",
          },
        },
      ],
      recorder
    );

    await expect(
      refreshTokens({
        credentials: VALID_CREDS,
        refreshToken: "RT-original",
        fetchImpl,
      })
    ).rejects.toThrow(/Bearer|token_type/);
  });
});
