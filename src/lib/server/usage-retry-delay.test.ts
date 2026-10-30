import { describe, expect, it } from "vitest";
import { backoffFor } from "./usage-retry-delay";

describe("backoffFor", () => {
  it("waits 250ms after the first failure, then 750ms, and never more", () => {
    expect([1, 2, 3, 9].map(backoffFor)).toEqual([250, 750, 750, 750]);
  });
});
