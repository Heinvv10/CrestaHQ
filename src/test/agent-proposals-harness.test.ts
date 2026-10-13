import { describe, expect, it } from "vitest";
import { settleWithin } from "./agent-proposals-harness";

describe("settleWithin", () => {
  it("fails a hung import with a clear error instead of waiting forever", async () => {
    await expect(settleWithin(new Promise(() => {}), 50, "the registry import")).rejects.toThrow(
      "the registry import did not finish within 0.05 s",
    );
  }, 2_000);

  it("passes through what settles in time", async () => {
    await expect(settleWithin(Promise.resolve("modules"), 1_000, "x")).resolves.toBe("modules");
    await expect(settleWithin(Promise.reject(new Error("boom")), 1_000, "x")).rejects.toThrow("boom");
  });
});
