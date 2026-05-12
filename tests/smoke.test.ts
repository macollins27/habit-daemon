import { describe, it, expect } from "vitest";
describe("smoke", () => {
  it("typescript compiles and vitest runs", () => {
    expect(1 + 1).toBe(2);
  });
});
