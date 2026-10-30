import { beforeEach, expect, it, vi } from "vitest";

/**
 * recordGateChanges: only a boolean is a gate value. A caller that passes a
 * non-boolean through (a string "true", null, a number) must not produce an
 * audit "change" — that row would claim a gate moved when it did not.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { recordGateChanges } from "./feature-gates-service";

const rows = () => mem.list("auditEvents").filter((r) => r.action === "feature_gates.updated");

beforeEach(() => resetSync());

it("ignores non-boolean gate values, recording only the real change", async () => {
  const gates = {
    reviewsAutoReplyEnabledByAgency: "true",
    reviewsAiEnabledByAgency: null,
    labsEnabledByAgency: 1,
    websiteEnabledByAgency: true,
  } as unknown as Parameters<typeof recordGateChanges>[3];
  await recordGateChanges(SA, "uid_owner", {}, gates);
  expect(rows()).toHaveLength(1);
  expect(rows()[0].changes).toEqual([{ field: "websiteEnabledByAgency", before: false, after: true }]);
});

it("records nothing when every value is non-boolean", async () => {
  const gates = { reviewsAutoReplyEnabledByAgency: "true" } as unknown as Parameters<typeof recordGateChanges>[3];
  await recordGateChanges(SA, "uid_owner", {}, gates);
  expect(rows()).toHaveLength(0);
});
