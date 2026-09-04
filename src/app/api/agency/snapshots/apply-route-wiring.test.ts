import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SnapshotPayload } from "@/types/snapshots";

/**
 * Route-handler test for apply-snapshot.
 *
 * This exists because a unit test of `applySnapshot` cannot catch the bug it
 * guards. The route used to build the payload by hand-listing four entity
 * types, so custom fields and the AI persona were silently dropped between the
 * stored snapshot and the function — every unit test passed while the feature
 * was unreachable in production. The assertion that matters is WHAT the route
 * forwards, which only a test that calls the route can make.
 */

const applySnapshot = vi.fn();
const requireSubAccountMember = vi.fn();
let snapshotDoc: Record<string, unknown> | undefined;

vi.mock("@/lib/snapshots/apply", () => ({
  applySnapshot: (...a: unknown[]) => applySnapshot(...a),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: (...a: unknown[]) => requireSubAccountMember(...a),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({
        exists: snapshotDoc !== undefined,
        data: () => snapshotDoc,
      }),
    }),
  }),
}));

import { POST } from "./../sub-accounts/[id]/apply-snapshot/route";

const call = () =>
  POST(
    new Request("http://localhost/api/agency/sub-accounts/sa_dst/apply-snapshot", {
      method: "POST",
      body: JSON.stringify({ snapshotId: "snap_1" }),
    }),
    { params: Promise.resolve({ id: "sa_dst" }) },
  );

describe("apply-snapshot route — payload forwarding", () => {
  beforeEach(() => {
    applySnapshot.mockReset().mockResolvedValue({});
    requireSubAccountMember
      .mockReset()
      .mockResolvedValue({ subAccountRole: "agencyOwner", agencyId: "ag_1", uid: "u_1" });
    snapshotDoc = undefined;
  });

  it("forwards custom fields and the AI persona to applySnapshot", async () => {
    // The regression: these two were dropped between the stored doc and the
    // function, so the feature could never fire in production.
    const payload: SnapshotPayload = {
      forms: [],
      messageTemplates: [],
      products: [],
      workflows: [],
      customFields: [
        { sourceId: "cf1", entity: "contact", key: "install_date", label: "Install date" },
      ] as SnapshotPayload["customFields"],
      aiProfile: {
        systemPrompt: "You are Velo.",
        hoursStart: 8,
        hoursEnd: 17,
        timezone: "Africa/Johannesburg",
        escalationKeywords: ["manager"],
      },
    };
    snapshotDoc = { payload };

    await call();

    const forwarded = applySnapshot.mock.calls[0][1] as SnapshotPayload;
    expect(forwarded.customFields).toHaveLength(1);
    expect(forwarded.customFields![0].key).toBe("install_date");
    expect(forwarded.aiProfile?.systemPrompt).toBe("You are Velo.");
  });

  it("defaults the required arrays for a snapshot captured before they existed", async () => {
    snapshotDoc = { payload: { forms: [{ sourceId: "f1" }] } };

    await call();

    const forwarded = applySnapshot.mock.calls[0][1] as SnapshotPayload;
    expect(forwarded.forms).toHaveLength(1);
    expect(forwarded.messageTemplates).toEqual([]);
    expect(forwarded.workflows).toEqual([]);
    expect(forwarded.products).toEqual([]);
    expect(forwarded.customFields).toBeUndefined();
    expect(forwarded.aiProfile).toBeUndefined();
  });

  it("refuses a caller who is not the agency owner", async () => {
    requireSubAccountMember.mockResolvedValue({
      subAccountRole: "subAccountAdmin",
      agencyId: "ag_1",
      uid: "u_2",
    });
    const res = await call();
    expect(res.status).toBe(403);
    expect(applySnapshot).not.toHaveBeenCalled();
  });
});
