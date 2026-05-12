import { describe, it, expect } from "vitest";
import { verifyImage, type DispatchResult } from "../../src/lib/vision-verify.js";

/**
 * Build a mock dispatchImpl that returns a fixed DispatchResult AND records
 * the prompt + jsonSchema it was called with for later assertions.
 */
function makeMockDispatch(result: DispatchResult): {
  fn: (opts: { prompt: string; jsonSchema: string }) => Promise<DispatchResult>;
  calls: { prompt: string; jsonSchema: string }[];
} {
  const calls: { prompt: string; jsonSchema: string }[] = [];
  const fn = async (opts: { prompt: string; jsonSchema: string }): Promise<DispatchResult> => {
    calls.push({ prompt: opts.prompt, jsonSchema: opts.jsonSchema });
    return result;
  };
  return { fn, calls };
}

describe("verifyImage — pm5_screen pass / threshold-fail paths", () => {
  it("passes when pm5 data is valid AND meets thresholds", async () => {
    const { fn } = makeMockDispatch({
      structured_output: {
        is_pm5: true,
        duration_minutes: 12,
        meters: 2143,
        completed: true,
        confidence: 0.95,
      },
    });
    const result = await verifyImage({
      imageUrl: "https://example.com/pm5.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.parsed).toMatchObject({
      is_pm5: true,
      duration_minutes: 12,
      meters: 2143,
      completed: true,
      confidence: 0.95,
    });
  });

  it("fails when pm5 duration_minutes is under the 10-min floor", async () => {
    const { fn } = makeMockDispatch({
      structured_output: {
        is_pm5: true,
        duration_minutes: 5,
        meters: 800,
        completed: true,
        confidence: 0.9,
      },
    });
    const result = await verifyImage({
      imageUrl: "https://example.com/short.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("5");
    expect(result.reason).toContain("min");
  });

  it("fails when pm5 session was not completed", async () => {
    const { fn } = makeMockDispatch({
      structured_output: {
        is_pm5: true,
        duration_minutes: 12,
        meters: 2143,
        completed: false,
        confidence: 0.95,
      },
    });
    const result = await verifyImage({
      imageUrl: "https://example.com/in-progress.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not completed");
  });

  it("fails when the photo is not a PM5 screen at all", async () => {
    const { fn } = makeMockDispatch({
      structured_output: {
        is_pm5: false,
        duration_minutes: 0,
        meters: 0,
        completed: false,
        confidence: 0.2,
      },
    });
    const result = await verifyImage({
      imageUrl: "https://example.com/cat.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not a PM5");
  });
});

describe("verifyImage — training_log pass / threshold-fail paths", () => {
  it("passes when training_log data is valid AND meets thresholds", async () => {
    const { fn } = makeMockDispatch({
      structured_output: {
        is_training_log: true,
        entries_visible: 4,
        confidence: 0.85,
      },
    });
    const result = await verifyImage({
      imageUrl: "https://example.com/log.jpg",
      subject: "training_log",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.parsed).toMatchObject({
      is_training_log: true,
      entries_visible: 4,
      confidence: 0.85,
    });
  });

  it("fails when training_log shows fewer than 3 entries", async () => {
    const { fn } = makeMockDispatch({
      structured_output: {
        is_training_log: true,
        entries_visible: 2,
        confidence: 0.9,
      },
    });
    const result = await verifyImage({
      imageUrl: "https://example.com/short-log.jpg",
      subject: "training_log",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("2");
    expect(result.reason).toContain("entries");
  });
});

describe("verifyImage — schema validation failures", () => {
  it("fails with reason mentioning 'schema' when structured_output is missing required fields", async () => {
    const { fn } = makeMockDispatch({
      // Missing `completed` and `confidence` — pm5_screen schema requires them.
      structured_output: {
        is_pm5: true,
        duration_minutes: 12,
        meters: 2143,
      },
    });
    const result = await verifyImage({
      imageUrl: "https://example.com/bad-shape.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/schema/i);
  });

  it("fails with reason mentioning 'schema' when training_log confidence exceeds 1", async () => {
    const { fn } = makeMockDispatch({
      structured_output: {
        is_training_log: true,
        entries_visible: 4,
        confidence: 1.5,
      },
    });
    const result = await verifyImage({
      imageUrl: "https://example.com/bad-confidence.jpg",
      subject: "training_log",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/schema/i);
  });
});

describe("verifyImage — dispatch-layer failures", () => {
  it("fails with reason mentioning 'dispatch' when dispatchImpl returns an error", async () => {
    const { fn } = makeMockDispatch({ error: "claude exited 1: oauth refresh failed" });
    const result = await verifyImage({
      imageUrl: "https://example.com/img.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("dispatch");
    expect(result.reason).toContain("claude exited 1");
  });

  it("fails with reason mentioning no structured_output when dispatchImpl returns an empty object", async () => {
    const { fn } = makeMockDispatch({});
    const result = await verifyImage({
      imageUrl: "https://example.com/img.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("structured_output");
  });
});

describe("verifyImage — prompt construction", () => {
  it("includes both the image URL and the registry prompt for pm5_screen", async () => {
    const { fn, calls } = makeMockDispatch({
      structured_output: {
        is_pm5: true,
        duration_minutes: 12,
        meters: 2143,
        completed: true,
        confidence: 0.95,
      },
    });
    await verifyImage({
      imageUrl: "https://images.example/pm5-uuid-7.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("https://images.example/pm5-uuid-7.jpg");
    // Verbatim registry phrase for pm5_screen.
    expect(prompt).toContain("Concept2 PM5 monitor");
    expect(prompt).toContain("duration ≥ 10:00");
  });

  it("includes both the image URL and the registry prompt for training_log", async () => {
    const { fn, calls } = makeMockDispatch({
      structured_output: {
        is_training_log: true,
        entries_visible: 4,
        confidence: 0.85,
      },
    });
    await verifyImage({
      imageUrl: "https://images.example/log-uuid-8.jpg",
      subject: "training_log",
      dispatchImpl: fn,
    });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("https://images.example/log-uuid-8.jpg");
    expect(prompt).toContain("workout/training log");
    expect(prompt).toContain("≥3");
  });
});

describe("verifyImage — JSON Schema construction", () => {
  it("passes a parseable JSON Schema string that describes the expected fields", async () => {
    const { fn, calls } = makeMockDispatch({
      structured_output: {
        is_pm5: true,
        duration_minutes: 12,
        meters: 2143,
        completed: true,
        confidence: 0.95,
      },
    });
    await verifyImage({
      imageUrl: "https://example.com/pm5.jpg",
      subject: "pm5_screen",
      dispatchImpl: fn,
    });
    const jsonSchema = calls[0]!.jsonSchema;
    // Must be a JSON-parseable string.
    const parsed = JSON.parse(jsonSchema) as Record<string, unknown>;
    expect(typeof parsed).toBe("object");
    // Must describe the pm5_screen response fields.
    const serialized = JSON.stringify(parsed);
    expect(serialized).toContain("is_pm5");
    expect(serialized).toContain("duration_minutes");
    expect(serialized).toContain("meters");
    expect(serialized).toContain("completed");
    expect(serialized).toContain("confidence");
  });

  it("strips the $schema field from the JSON Schema (Anthropic silently rejects schemas with $schema)", async () => {
    const { fn, calls } = makeMockDispatch({
      structured_output: {
        is_training_log: true,
        entries_visible: 4,
        confidence: 0.85,
      },
    });
    await verifyImage({
      imageUrl: "https://example.com/log.jpg",
      subject: "training_log",
      dispatchImpl: fn,
    });
    const jsonSchema = calls[0]!.jsonSchema;
    const parsed = JSON.parse(jsonSchema) as Record<string, unknown>;
    expect(parsed["$schema"]).toBeUndefined();
  });
});
