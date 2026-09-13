import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * DELETE /api/v1/events/:id with a Google copy that could not be removed:
 * refused (409 google_removal_failed) and the event kept — deleting would
 * orphan the copy while reporting success.
 */

const CTX = { agencyId: "ag1", subAccountId: "sa1", keyId: "k", keyPrefix: "lsk_x", mode: "live", scopes: ["admin"], requestId: "r", apiVersion: "2026-01-01" };
const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("@/lib/api/auth", () => ({
  withApiAuth:
    (handler: (input: Record<string, unknown>) => Promise<Response>) =>
    async (_req: Request, routeCtx: { params: Promise<{ id: string }> }) =>
      handler({ params: await routeCtx.params, ctx: CTX }),
}));
const g = vi.hoisted(() => ({ result: { ok: true } as { ok: true } | { ok: false; message: string } }));
vi.mock("@/lib/google-calendar/push", () => ({
  removeBookingFromGoogleBeforeDelete: async () => g.result,
}));

const { DELETE } = await import("./route");
const del = () => DELETE(new Request("http://x/api", { method: "DELETE" }), { params: Promise.resolve({ id: "e1" }) });

beforeEach(() => {
  mem.clear();
  mem.seed("events/e1", { id: "e1", subAccountId: "sa1", agencyId: "ag1", mode: "live", googleEventIds: { a: "g" } });
});

describe("v1 DELETE with a Google copy", () => {
  it("refuses and keeps the event when a copy is left", async () => {
    g.result = { ok: false, message: "Couldn't remove it from Ann's Google Calendar — try again." };
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "google_removal_failed" });
    expect(mem.read("events/e1")).toBeDefined();
  });

  it("deletes once every copy is gone", async () => {
    g.result = { ok: true };
    expect((await del()).status).toBe(200);
    expect(mem.read("events/e1")).toBeUndefined();
  });
});
