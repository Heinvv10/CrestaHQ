import { expect, it, vi } from "vitest";
import type { Timestamp } from "firebase/firestore";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { createdEventFromResponse } from "@/lib/calendar/event-overrides-view";

/**
 * The calendar shows a new event from POST /api/events' 201, before its
 * Listen delta arrives, so the 201 must carry what was stored. Real route +
 * events service, in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u_member", subAccountId: "sa1", subAccountRole: "admin" }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));

const { POST } = await import("./route");

it("returns the stored event, which the client rebuilds field for field", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  const res = await POST(new Request("http://x/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subAccountId: "sa1", title: "Site visit", location: "Gate 2",
      startAt: "2026-10-01T09:00:00Z", endAt: "2026-10-01T10:00:00Z",
    }),
  }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  const doc = mem.read(`events/${body.id}`)!;

  const shown = createdEventFromResponse(body)!;
  expect(shown.id).toBe(body.id);
  expect((shown.startAt as Timestamp).toMillis()).toBe(Date.parse("2026-10-01T09:00:00Z"));
  expect((shown.endAt as Timestamp).toMillis()).toBe(Date.parse("2026-10-01T10:00:00Z"));
  for (const key of ["title", "location", "contactId", "status", "source", "subAccountId", "agencyId", "createdByUid", "territoryId"]) {
    expect(shown[key as keyof typeof shown], key).toEqual(doc[key]);
  }
});

it("a body without the stored event yields nothing to show", () => {
  expect(createdEventFromResponse({ id: "e1" })).toBeNull();
  expect(createdEventFromResponse({ id: "e1", stored: { title: "x", startAt: "nope", endAt: "2026-10-01T10:00:00Z" } })).toBeNull();
  expect(createdEventFromResponse({ stored: { title: "x", startAt: "2026-10-01T09:00:00Z", endAt: "2026-10-01T10:00:00Z" } })).toBeNull();
  expect(createdEventFromResponse(null)).toBeNull();
});
