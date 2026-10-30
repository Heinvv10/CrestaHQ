import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { PAGE } from "@/test/booking-fixtures";

/**
 * Google Meet through the agent's update_booking_page (the real dispatch):
 * a full-replace save, so a page stored before `location` existed (only
 * `googleMeet: true`) must keep Meet; and a Meet page whose host has since
 * disconnected can still be edited — with a warning — not locked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const P = "subAccounts/sa1/bookingPages";
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
const { location: _none, ...LEGACY } = PAGE;
const connect = (status: string) => mem.seed("subAccounts/sa1/private/googleCalendar_h1", { uid: "h1", status });

beforeEach(() => {
  mem.seed("subAccounts/sa1", { ...(mem.read("subAccounts/sa1") as object), googleCalendarEnabledByAgency: true });
  mem.seed("subAccounts/sa1/subAccountMembers/h1", { uid: "h1", status: "active", displayName: "Hana" });
  connect("connected");
  mem.seed(`${P}/legacy`, {
    ...LEGACY,
    id: "legacy",
    slug: "legacy",
    name: "Legacy",
    calendarType: "round_robin",
    hosts: [{ uid: "h1", name: "Hana" }],
    googleMeet: true,
  });
});

describe("update_booking_page on a Google Meet page", () => {
  it("a page stored with only googleMeet: true keeps Meet across an edit of another field", async () => {
    expect(await call("update_booking_page", { slug: "legacy", durationMinutes: 45 })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/legacy`)).toMatchObject({
      durationMinutes: 45,
      googleMeet: true,
      location: { type: "google_meet", value: null },
    });
  });

  it("a host who disconnected since doesn't lock the page: the edit saves", async () => {
    connect("revoked");
    expect(await call("update_booking_page", { slug: "legacy", durationMinutes: 45 })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/legacy`)).toMatchObject({ durationMinutes: 45, googleMeet: true });
  });
});
