import { beforeEach, expect, it, vi } from "vitest";

/**
 * Retry sync's 200 says whether the event is now synced (`synced`), read
 * after the push, so the dialog can clear its notice without the Listen
 * delta — and only then.
 */
const m = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", agencyId: "ag1" }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({ territoryGate: async () => null }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: m.push }));

let eventDoc: Record<string, unknown> | undefined;
const ref = {
  get: async () => ({ exists: eventDoc !== undefined, data: () => eventDoc }),
  update: async (patch: Record<string, unknown>) => void Object.assign(eventDoc!, patch),
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: () => ({ doc: () => ref }),
    runTransaction: async (fn: (txn: unknown) => Promise<unknown>) =>
      fn({ get: () => ref.get(), update: (_r: unknown, patch: Record<string, unknown>) => Object.assign(eventDoc!, patch) }),
  }),
}));

const { POST } = await import("./route");
const retry = async () => {
  const res = await POST(new Request("http://x/api/events/by-id/e1/google-sync", { method: "POST" }), {
    params: Promise.resolve({ id: "e1" }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  m.push.mockReset();
  eventDoc = { subAccountId: "sa1", googleSyncError: { message: "Not in Ann's Google Calendar", at: new Date() } };
});

it("says synced when the push cleared the error", async () => {
  m.push.mockImplementation(async () => void (eventDoc!.googleSyncError = null));
  expect(await retry()).toEqual({ status: 200, body: { ok: true, synced: true, googleSyncError: null } });
});

it("says not synced, with the reason, when the push failed again", async () => {
  m.push.mockImplementation(async () => void (eventDoc!.googleSyncError = { message: "Still not in Ann's", at: new Date() }));
  expect(await retry()).toEqual({ status: 200, body: { ok: true, synced: false, googleSyncError: "Still not in Ann's" } });
});

it("says not synced when the event is gone after the push", async () => {
  m.push.mockImplementation(async () => void (eventDoc = undefined));
  expect((await retry()).body.synced).toBe(false);
});
