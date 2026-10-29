import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The open / click tracking switches on the sub-account PATCH. Each kind is
 * written by dot path, so switching one never resets the other; anything but
 * a boolean is refused without a write.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u1" }),
  requireAgencyOwnerAny: async () => ({ uid: "u1", agencyId: "ag1" }),
}));

const { PATCH } = await import("./route");

const ctx = { params: Promise.resolve({ id: "sa1" }) };
const patch = (body: unknown) =>
  PATCH(new Request("https://app.test/x", { method: "PATCH", body: JSON.stringify(body) }), ctx);
const tracking = () => mem.read("subAccounts/sa1")!.emailTracking;

beforeEach(() => {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Fixture" });
});

it("switches each kind on and off without touching the other", async () => {
  expect((await patch({ emailTracking: { opens: true } })).status).toBe(200);
  expect(tracking()).toEqual({ opens: true });
  expect((await patch({ emailTracking: { clicks: true } })).status).toBe(200);
  expect(tracking()).toEqual({ opens: true, clicks: true });
  expect((await patch({ emailTracking: { opens: false } })).status).toBe(200);
  expect(tracking()).toEqual({ opens: false, clicks: true });
});

it("refuses a non-boolean or a non-object, writing nothing", async () => {
  for (const emailTracking of [{ opens: "yes" }, { clicks: 1 }, null, "on", true]) {
    expect((await patch({ emailTracking })).status).toBe(400);
  }
  // An object with neither key is "no fields to update".
  expect((await patch({ emailTracking: {} })).status).toBe(400);
  expect(tracking()).toBeUndefined();
});
