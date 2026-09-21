import { describe, expect, it } from "vitest";

import { validateCustomFieldCapacity } from "@/lib/custom-fields/validation";

describe("custom-field capacity", () => {
  it("allows GHL migrations to add fields after the legacy 50-field boundary", () => {
    expect(validateCustomFieldCapacity(50, "contact")).toEqual({ ok: true });
  });

  it("still rejects definitions after the expanded limit is reached", () => {
    expect(validateCustomFieldCapacity(100, "contact")).toEqual({
      ok: false,
      error: "At most 100 custom fields per contact.",
    });
  });
});
