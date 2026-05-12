import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  VISION_REGISTRY,
  TrainingLogResponseSchema,
  Pm5ScreenResponseSchema,
  type VisionSubject,
  type TrainingLogResponse,
  type Pm5ScreenResponse,
} from "../../src/lib/vision-registry.js";

describe("VISION_REGISTRY shape", () => {
  it("has exactly training_log and pm5_screen entries", () => {
    const keys = Object.keys(VISION_REGISTRY).sort();
    expect(keys).toEqual(["pm5_screen", "training_log"]);
  });

  it("each entry has prompt (string), schema (Zod), threshold (function)", () => {
    for (const subject of ["training_log", "pm5_screen"] as const) {
      const entry = VISION_REGISTRY[subject];
      expect(typeof entry.prompt).toBe("string");
      expect(entry.prompt.length).toBeGreaterThan(0);
      expect(entry.schema).toBeInstanceOf(z.ZodType);
      expect(typeof entry.threshold).toBe("function");
    }
  });
});

describe("training_log prompt content (design § 4 verbatim phrases)", () => {
  const prompt = VISION_REGISTRY.training_log.prompt;

  it("mentions workout/training log", () => {
    expect(prompt).toContain("workout/training log");
  });

  it("requires at least 3 distinct lift entries (verbatim ≥3)", () => {
    expect(prompt).toContain("≥3");
    expect(prompt).toContain("distinct lift entries");
  });

  it("specifies lift name + weight + reps", () => {
    expect(prompt).toContain("lift name");
    expect(prompt).toContain("weight");
    expect(prompt).toContain("reps");
  });

  it("requests JSON output with is_training_log + entries_visible + confidence", () => {
    expect(prompt).toContain("is_training_log");
    expect(prompt).toContain("entries_visible");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("rejection_reason");
  });
});

describe("pm5_screen prompt content (design § 4 verbatim phrases)", () => {
  const prompt = VISION_REGISTRY.pm5_screen.prompt;

  it("mentions Concept2 PM5 monitor", () => {
    expect(prompt).toContain("Concept2 PM5 monitor");
  });

  it("requires duration ≥ 10:00 (verbatim unicode)", () => {
    expect(prompt).toContain("duration ≥ 10:00");
  });

  it("requires completed (not in-progress) session", () => {
    expect(prompt).toContain("completed");
    expect(prompt).toContain("in-progress");
  });

  it("requests JSON output with is_pm5 + duration_minutes + meters + completed + confidence", () => {
    expect(prompt).toContain("is_pm5");
    expect(prompt).toContain("duration_minutes");
    expect(prompt).toContain("meters");
    expect(prompt).toContain("completed");
    expect(prompt).toContain("confidence");
  });
});

describe("TrainingLogResponseSchema", () => {
  it("parses a valid full response (no rejection_reason)", () => {
    const parsed: TrainingLogResponse = TrainingLogResponseSchema.parse({
      is_training_log: true,
      entries_visible: 5,
      confidence: 0.9,
    });
    expect(parsed.is_training_log).toBe(true);
    expect(parsed.entries_visible).toBe(5);
    expect(parsed.confidence).toBe(0.9);
    expect(parsed.rejection_reason).toBeUndefined();
  });

  it("parses a valid response with optional rejection_reason", () => {
    const parsed = TrainingLogResponseSchema.parse({
      is_training_log: false,
      entries_visible: 0,
      confidence: 0.5,
      rejection_reason: "blurry photo",
    });
    expect(parsed.rejection_reason).toBe("blurry photo");
  });

  it("throws when a required field is missing", () => {
    expect(() =>
      TrainingLogResponseSchema.parse({
        is_training_log: true,
        entries_visible: 3,
      }),
    ).toThrow();
  });

  it("throws when confidence > 1", () => {
    expect(() =>
      TrainingLogResponseSchema.parse({
        is_training_log: true,
        entries_visible: 3,
        confidence: 1.5,
      }),
    ).toThrow();
  });

  it("throws when confidence < 0", () => {
    expect(() =>
      TrainingLogResponseSchema.parse({
        is_training_log: true,
        entries_visible: 3,
        confidence: -0.1,
      }),
    ).toThrow();
  });

  it("throws when is_training_log is not a boolean", () => {
    expect(() =>
      TrainingLogResponseSchema.parse({
        is_training_log: "yes",
        entries_visible: 3,
        confidence: 0.8,
      }),
    ).toThrow();
  });
});

describe("Pm5ScreenResponseSchema", () => {
  it("parses a valid full response", () => {
    const parsed: Pm5ScreenResponse = Pm5ScreenResponseSchema.parse({
      is_pm5: true,
      duration_minutes: 12,
      meters: 2143,
      completed: true,
      confidence: 0.95,
    });
    expect(parsed.is_pm5).toBe(true);
    expect(parsed.duration_minutes).toBe(12);
    expect(parsed.meters).toBe(2143);
    expect(parsed.completed).toBe(true);
    expect(parsed.confidence).toBe(0.95);
  });

  it("parses a valid response with optional rejection_reason", () => {
    const parsed = Pm5ScreenResponseSchema.parse({
      is_pm5: false,
      duration_minutes: 0,
      meters: 0,
      completed: false,
      confidence: 0.2,
      rejection_reason: "not a PM5 display",
    });
    expect(parsed.rejection_reason).toBe("not a PM5 display");
  });

  it("throws when a required field is missing", () => {
    expect(() =>
      Pm5ScreenResponseSchema.parse({
        is_pm5: true,
        duration_minutes: 10,
        meters: 2000,
        confidence: 0.9,
      }),
    ).toThrow();
  });

  it("throws when confidence > 1", () => {
    expect(() =>
      Pm5ScreenResponseSchema.parse({
        is_pm5: true,
        duration_minutes: 10,
        meters: 2000,
        completed: true,
        confidence: 1.2,
      }),
    ).toThrow();
  });

  it("throws when confidence < 0", () => {
    expect(() =>
      Pm5ScreenResponseSchema.parse({
        is_pm5: true,
        duration_minutes: 10,
        meters: 2000,
        completed: true,
        confidence: -0.5,
      }),
    ).toThrow();
  });
});

describe("training_log threshold", () => {
  const threshold = VISION_REGISTRY.training_log.threshold;

  it("passes when is_training_log=true, entries_visible=4, confidence=0.85", () => {
    const result = threshold({
      is_training_log: true,
      entries_visible: 4,
      confidence: 0.85,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails when is_training_log=false with reason mentioning 'not a training log'", () => {
    const result = threshold({
      is_training_log: false,
      entries_visible: 5,
      confidence: 0.9,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not a training log");
  });

  it("fails when entries_visible < 3 with reason mentioning the count", () => {
    const result = threshold({
      is_training_log: true,
      entries_visible: 2,
      confidence: 0.9,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("2");
  });

  it("fails when confidence < 0.7 with reason mentioning the confidence value", () => {
    const result = threshold({
      is_training_log: true,
      entries_visible: 5,
      confidence: 0.5,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("0.5");
  });

  it("passes exactly at the boundary (entries_visible=3, confidence=0.7)", () => {
    const result = threshold({
      is_training_log: true,
      entries_visible: 3,
      confidence: 0.7,
    });
    expect(result.passed).toBe(true);
  });
});

describe("pm5_screen threshold", () => {
  const threshold = VISION_REGISTRY.pm5_screen.threshold;

  it("passes when is_pm5=true, completed=true, duration_minutes=12", () => {
    const result = threshold({
      is_pm5: true,
      duration_minutes: 12,
      meters: 2143,
      completed: true,
      confidence: 0.9,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails when is_pm5=false with reason mentioning 'not a PM5'", () => {
    const result = threshold({
      is_pm5: false,
      duration_minutes: 12,
      meters: 2143,
      completed: true,
      confidence: 0.9,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not a PM5");
  });

  it("fails when completed=false with reason mentioning 'not completed'", () => {
    const result = threshold({
      is_pm5: true,
      duration_minutes: 12,
      meters: 2143,
      completed: false,
      confidence: 0.9,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("not completed");
  });

  it("fails when duration_minutes < 10 with reason mentioning the duration", () => {
    const result = threshold({
      is_pm5: true,
      duration_minutes: 8,
      meters: 1500,
      completed: true,
      confidence: 0.9,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("8");
  });

  it("passes exactly at the boundary (duration_minutes=10)", () => {
    const result = threshold({
      is_pm5: true,
      duration_minutes: 10,
      meters: 2000,
      completed: true,
      confidence: 0.9,
    });
    expect(result.passed).toBe(true);
  });
});

describe("VisionSubject type union", () => {
  it("permits 'training_log' and 'pm5_screen' as VisionSubject values", () => {
    const a: VisionSubject = "training_log";
    const b: VisionSubject = "pm5_screen";
    expect(a).toBe("training_log");
    expect(b).toBe("pm5_screen");
  });

  it("exposes exactly two registry keys at runtime", () => {
    const subjects: VisionSubject[] = Object.keys(
      VISION_REGISTRY,
    ) as VisionSubject[];
    expect(subjects).toHaveLength(2);
    expect(subjects.sort()).toEqual(["pm5_screen", "training_log"]);
  });
});
