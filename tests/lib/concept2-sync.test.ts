import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import {
  syncDate,
  type Concept2Credentials,
  type Concept2Result,
  type Concept2Tokens,
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

interface SensorSignalRow {
  readonly id: string;
  readonly source: string;
  readonly payload_date: string;
  readonly payload_json: string;
  readonly fetched_at: number;
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

function readAllSignals(db: Database.Database): SensorSignalRow[] {
  return db
    .prepare(
      "SELECT id, source, payload_date, payload_json, fetched_at FROM sensor_signals ORDER BY id"
    )
    .all() as SensorSignalRow[];
}

// Raw upstream rows match the Concept2 Logbook API shape:
//   `time` is in deciseconds (tenths of a second), `distance` is in meters.
// fetchRowsBetween() inside syncDate transforms these into the internal
// Concept2Result shape (`duration_seconds`, `distance_meters`) before they
// are serialized into the sensor_signals payload_json. Phase 7 test-hygiene:
// mocks intentionally use the raw shape so the boundary transform is
// exercised end-to-end. A regression like the 2026-05-13 outage (raw
// `time` accidentally treated as seconds) would surface here immediately.
interface Concept2RawRow {
  readonly id: number;
  readonly date: string;
  readonly type: string;
  readonly time: number; // deciseconds
  readonly distance: number; // meters
  readonly time_formatted: string;
}

const RAW_ROW_A: Concept2RawRow = {
  id: 100,
  date: "2026-05-12 09:15:00",
  type: "rower",
  time: 7200, // 720.0 s
  distance: 2143,
  time_formatted: "12:00.0",
};

const RAW_ROW_B: Concept2RawRow = {
  id: 101,
  date: "2026-05-12 18:00:00",
  type: "rower",
  time: 6000, // 600.0 s
  distance: 1800,
  time_formatted: "10:00.0",
};

const RAW_ROW_C: Concept2RawRow = {
  id: 102,
  date: "2026-05-12 21:30:00",
  type: "rower",
  time: 5400, // 540.0 s
  distance: 1600,
  time_formatted: "9:00.0",
};

// Expected post-transform results (Concept2Result internal shape).
const EXPECTED_ROW_A: Concept2Result = {
  id: 100,
  date: "2026-05-12 09:15:00",
  type: "rower",
  duration_seconds: 720,
  distance_meters: 2143,
};

const EXPECTED_ROW_B: Concept2Result = {
  id: 101,
  date: "2026-05-12 18:00:00",
  type: "rower",
  duration_seconds: 600,
  distance_meters: 1800,
};

const EXPECTED_ROW_C: Concept2Result = {
  id: 102,
  date: "2026-05-12 21:30:00",
  type: "rower",
  duration_seconds: 540,
  distance_meters: 1600,
};

describe("syncDate() — happy path", () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:34:56.000Z"));
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("writes exactly one sensor_signals row with the expected shape", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            data: [RAW_ROW_A, RAW_ROW_B],
            links: { next: null },
          },
        },
      ],
      recorder
    );

    await syncDate({
      db,
      date: new Date("2026-05-12T10:00:00Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
    });

    const rows = readAllSignals(db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.source).toBe("concept2");
    expect(row.payload_date).toBe("2026-05-12");
    expect(row.id).toBe("concept2-2026-05-12");
    expect(row.fetched_at).toBe(Date.now());

    const parsed = JSON.parse(row.payload_json) as {
      results: Concept2Result[];
    };
    // payload_json holds the post-transform internal shape.
    expect(parsed).toEqual({ results: [EXPECTED_ROW_A, EXPECTED_ROW_B] });
  });

  it("queries fetchRowsBetween with from === to === opts.date (YYYY-MM-DD)", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [{ ok: true, body: { data: [RAW_ROW_A], links: { next: null } } }],
      recorder
    );

    await syncDate({
      db,
      // Mid-day timestamp; toIsoDate truncates to UTC YYYY-MM-DD.
      date: new Date("2026-05-12T15:30:00Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
    });

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(
      "https://log.concept2.com/api/users/me/results"
    );
    expect(url.searchParams.get("from")).toBe("2026-05-12");
    expect(url.searchParams.get("to")).toBe("2026-05-12");
    // Sanity: not a full ISO timestamp.
    expect(url.searchParams.get("from")).not.toContain("T");
  });

  it("writes payload_date in YYYY-MM-DD form (not a full ISO timestamp)", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [{ ok: true, body: { data: [], links: { next: null } } }],
      recorder
    );

    await syncDate({
      db,
      date: new Date("2026-05-12T23:59:59Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
    });

    const rows = readAllSignals(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_date).toBe("2026-05-12");
    expect(rows[0].payload_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("writes a row with empty results array when the API returns no rows", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [{ ok: true, body: { data: [], links: { next: null } } }],
      recorder
    );

    await syncDate({
      db,
      date: new Date("2026-05-12T10:00:00Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
    });

    const rows = readAllSignals(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_json).toBe('{"results":[]}');
  });
});

describe("syncDate() — idempotency", () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("a second sync for the same date replaces the existing row (no duplicates)", async () => {
    // First sync: returns row A only (raw upstream shape).
    const recorder1: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl1 = makeMultiFetchMock(
      [{ ok: true, body: { data: [RAW_ROW_A], links: { next: null } } }],
      recorder1
    );

    await syncDate({
      db,
      date: new Date("2026-05-12T10:00:00Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: fetchImpl1,
    });

    const firstRows = readAllSignals(db);
    expect(firstRows).toHaveLength(1);
    const firstFetchedAt = firstRows[0].fetched_at;

    // Advance the clock so we can verify fetched_at updates on replace.
    vi.setSystemTime(new Date("2026-05-12T13:00:00.000Z"));

    // Second sync: returns rows A and B (raw upstream shape).
    const recorder2: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl2 = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            data: [RAW_ROW_A, RAW_ROW_B],
            links: { next: null },
          },
        },
      ],
      recorder2
    );

    await syncDate({
      db,
      date: new Date("2026-05-12T10:00:00Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl: fetchImpl2,
    });

    const secondRows = readAllSignals(db);
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].id).toBe("concept2-2026-05-12");
    expect(secondRows[0].fetched_at).toBe(Date.now());
    expect(secondRows[0].fetched_at).toBeGreaterThan(firstFetchedAt);

    const parsed = JSON.parse(secondRows[0].payload_json) as {
      results: Concept2Result[];
    };
    // payload_json holds the post-transform internal shape.
    expect(parsed.results).toEqual([EXPECTED_ROW_A, EXPECTED_ROW_B]);
  });
});

describe("syncDate() — 401 + refresh integration", () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:00:00.000Z"));
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("refreshes tokens on 401, invokes onTokensRefreshed, and persists retry data", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        // 1) initial GET → 401
        { ok: false, status: 401, body: { error: "expired" } },
        // 2) refresh POST → new tokens
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
        // 3) retry GET → 200 with data (raw upstream shape)
        {
          ok: true,
          body: { data: [RAW_ROW_B], links: { next: null } },
        },
      ],
      recorder
    );

    const refreshed: Concept2Tokens[] = [];
    await syncDate({
      db,
      date: new Date("2026-05-12T10:00:00Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
      onTokensRefreshed: (t) => refreshed.push(t),
    });

    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].access_token).toBe("AT-new");
    expect(refreshed[0].refresh_token).toBe("RT-new");

    const rows = readAllSignals(db);
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0].payload_json) as {
      results: Concept2Result[];
    };
    // payload_json holds the post-transform internal shape.
    expect(parsed.results).toEqual([EXPECTED_ROW_B]);
  });
});

describe("syncDate() — pagination integration", () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("concatenates results from multiple pages into a single payload_json", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [
        {
          ok: true,
          body: {
            data: [RAW_ROW_A, RAW_ROW_B],
            links: {
              next: "https://log.concept2.com/api/users/me/results?from=2026-05-12&to=2026-05-12&page=2",
            },
          },
        },
        {
          ok: true,
          body: { data: [RAW_ROW_C], links: { next: null } },
        },
      ],
      recorder
    );

    await syncDate({
      db,
      date: new Date("2026-05-12T10:00:00Z"),
      credentials: VALID_CREDS,
      tokens: VALID_TOKENS,
      fetchImpl,
    });

    expect(recorder.calls).toHaveLength(2);
    const rows = readAllSignals(db);
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0].payload_json) as {
      results: Concept2Result[];
    };
    // payload_json holds the post-transform internal shape.
    expect(parsed.results).toEqual([
      EXPECTED_ROW_A,
      EXPECTED_ROW_B,
      EXPECTED_ROW_C,
    ]);
  });
});

describe("syncDate() — error propagation", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
  });

  it("propagates fetch errors and writes nothing to sensor_signals", async () => {
    const recorder: { calls: RecordedRequest[] } = { calls: [] };
    const fetchImpl = makeMultiFetchMock(
      [{ ok: false, status: 500, body: "boom" }],
      recorder
    );

    await expect(
      syncDate({
        db,
        date: new Date("2026-05-12T10:00:00Z"),
        credentials: VALID_CREDS,
        tokens: VALID_TOKENS,
        fetchImpl,
      })
    ).rejects.toThrow(/500|concept2|results/i);

    expect(readAllSignals(db)).toHaveLength(0);
  });
});
