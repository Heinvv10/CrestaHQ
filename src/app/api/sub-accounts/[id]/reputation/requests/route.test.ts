import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/reputation/requests — the Requests tab's list
 * (SP5 d1) over REAL require-tenancy and the in-memory Firestore: newest
 * first, pages of 50 with a cursor, status/channel/source filters, contact
 * names joined at read time from this sub-account's contacts only. Never a
 * body, phone number or email address.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, OTHER_SA, SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { GET } from "./route";

const NOW = Date.parse("2026-09-14T10:00:00Z");
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function read(query = "", uid = "uid_collab", sa = SA): Promise<{ status: number; body: Body }> {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${sa}/reputation/requests${query}`, uid), {
    params: Promise.resolve({ id: sa }),
  });
  const text = await res.text();
  expect(text).not.toMatch(/\+1500|@example\.test|g\.page|messageSid|SMrow/);
  return { status: res.status, body: JSON.parse(text) as Body };
}

/** Row `i` was sent `i` minutes before NOW. */
function seedRow(sa: string, i: number, more: Record<string, unknown> = {}) {
  mem.seed(`subAccounts/${sa}/reviewRequests/r${String(i).padStart(3, "0")}`, {
    agencyId: AGENCY, subAccountId: sa, createdByUid: "review-request", contactId: "c_one", channel: "sms",
    source: "dispatcher", trigger: "manual", status: "sent", failureKind: null, messageSid: `SMrow${i}`,
    sentAt: new Date(NOW - i * 60_000), clickedAt: null, feedbackAt: null, ...more,
  });
}

beforeEach(() => {
  resetSync();
  mem.seed("contacts/c_one", { name: "Fixture One", phone: "+15005550006", email: "one@example.test", agencyId: AGENCY, subAccountId: SA });
  mem.seed("contacts/c_two", { name: "Fixture Two", phone: "+15005550007", agencyId: AGENCY, subAccountId: SA });
  mem.seed("contacts/c_foreign", { name: "Other Tenant Person", agencyId: AGENCY, subAccountId: OTHER_SA });
});
afterEach(() => vi.restoreAllMocks());

describe("authorization and validation", () => {
  it.each([
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of ANOTHER sub-account", "uid_other_admin"],
  ])("refuses %s", async (_l, uid) => {
    expect((await read("", uid)).status).toBe(403);
  });

  it.each([
    ["status", "?status=clicked"],
    ["channel", "?channel=fax"],
    ["source", "?source=api"],
    ["cursor", "?cursor=../x"],
  ])("refuses an invalid %s", async (field, q) => {
    const { status, body } = await read(q);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "invalid_filter", field });
  });

  it("a cursor that is not a row of this sub-account's log is refused", async () => {
    seedRow(OTHER_SA, 1);
    expect((await read("?cursor=r001")).body).toMatchObject({ code: "invalid_filter", field: "cursor" });
  });
});

describe("the list", () => {
  it("newest first, this sub-account only, with the contact joined and nothing sensitive", async () => {
    seedRow(SA, 2, { contactId: "c_two", source: "workflow", trigger: null, createdByUid: "workflow" });
    seedRow(SA, 1);
    seedRow(SA, 3, { status: "failed", failureKind: "send_failed", messageSid: null, channel: "email", source: "broadcast" });
    seedRow(OTHER_SA, 0);
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.requests.map((r: Body) => r.id)).toEqual(["r001", "r002", "r003"]);
    expect(body.requests[0]).toEqual({
      id: "r001", contactId: "c_one", contactName: "Fixture One", channel: "sms", source: "dispatcher",
      trigger: "manual", status: "sent", failureKind: null, sentAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(body.requests[1]).toMatchObject({ contactName: "Fixture Two", source: "workflow", trigger: null });
    expect(body.requests[2]).toMatchObject({ status: "failed", failureKind: "send_failed", channel: "email" });
    expect(body.nextCursor).toBeNull();
  });

  it("a contact that is gone, or belongs to another sub-account, has no name", async () => {
    seedRow(SA, 1, { contactId: "c_deleted" });
    seedRow(SA, 2, { contactId: "c_foreign" });
    const { body } = await read();
    expect(body.requests.map((r: Body) => r.contactName)).toEqual([null, null]);
  });

  it("a territory-scoped collaborator sees the row but not a contact outside their territories", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, territoryScopingEnabled: true });
    mem.seed(`subAccounts/${SA}/subAccountMembers/uid_collab`, {
      ...mem.read(`subAccounts/${SA}/subAccountMembers/uid_collab`)!, assignedTerritoryIds: ["t_north"],
    });
    mem.seed("contacts/c_one", { ...mem.read("contacts/c_one")!, territoryId: "t_north" });
    mem.seed("contacts/c_two", { ...mem.read("contacts/c_two")!, territoryId: "t_south" });
    seedRow(SA, 1);
    seedRow(SA, 2, { contactId: "c_two" });
    const collab = (await read()).body.requests;
    expect(collab.map((r: Body) => [r.contactId, r.contactName])).toEqual([["c_one", "Fixture One"], [null, null]]);
    expect(collab[1]).toMatchObject({ id: "r002", status: "sent" });
    // An admin is never territory-scoped.
    const admin = (await read("", "uid_admin")).body.requests;
    expect(admin.map((r: Body) => r.contactName)).toEqual(["Fixture One", "Fixture Two"]);
  });

  it("scoped: Global contacts are visible; unassigned and missing contacts are hidden (territoryDenialForContact's rule)", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, territoryScopingEnabled: true });
    mem.seed(`subAccounts/${SA}/subAccountMembers/uid_collab`, {
      ...mem.read(`subAccounts/${SA}/subAccountMembers/uid_collab`)!, assignedTerritoryIds: ["t_north"],
    });
    mem.seed("contacts/c_one", { ...mem.read("contacts/c_one")!, territoryId: "global" });
    mem.seed("contacts/c_two", { ...mem.read("contacts/c_two")! }); // no territoryId
    seedRow(SA, 1);
    seedRow(SA, 2, { contactId: "c_two" });
    seedRow(SA, 3, { contactId: "c_gone" });
    const collab = (await read()).body.requests;
    expect(collab.map((r: Body) => [r.contactId, r.contactName])).toEqual([["c_one", "Fixture One"], [null, null], [null, null]]);
    // Unscoped, a missing contact keeps its id (shown as deleted).
    const admin = (await read("", "uid_admin")).body.requests;
    expect(admin.map((r: Body) => [r.contactId, r.contactName])).toEqual([["c_one", "Fixture One"], ["c_two", "Fixture Two"], ["c_gone", null]]);
  });

  it("rows written before d1 read as whatsapp / dispatcher", async () => {
    seedRow(SA, 1, { channel: "whatsapp_manual", source: undefined });
    expect((await read()).body.requests[0]).toMatchObject({ channel: "whatsapp", source: "dispatcher" });
  });
});

describe("paging", () => {
  it("50 per page; the cursor continues exactly after the last row, with no gap or repeat", async () => {
    for (let i = 1; i <= 120; i++) seedRow(SA, i);
    const p1 = (await read()).body;
    expect(p1.requests).toHaveLength(50);
    expect(p1.nextCursor).toBe("r050");
    const p2 = (await read(`?cursor=${p1.nextCursor}`)).body;
    expect(p2.requests[0].id).toBe("r051");
    const p3 = (await read(`?cursor=${p2.nextCursor}`)).body;
    expect(p3.requests.map((r: Body) => r.id)).toEqual(Array.from({ length: 20 }, (_, k) => `r${String(101 + k)}`));
    expect(p3.nextCursor).toBeNull();
  });

  it("filters apply before paging: a page holds 50 matching rows", async () => {
    for (let i = 1; i <= 150; i++) seedRow(SA, i, i % 3 === 0 ? { status: "failed", failureKind: "send_failed" } : {});
    const p1 = (await read("?status=failed")).body;
    expect(p1.requests).toHaveLength(50);
    expect(p1.requests.every((r: Body) => r.status === "failed")).toBe(true);
    expect(p1.nextCursor).toBeNull(); // exactly 50 failed rows exist
  });

  it("a sparse filter stops after 1,000 rows with a cursor to keep scanning", async () => {
    for (let i = 1; i <= 1005; i++) seedRow(SA, i, i === 1003 ? { status: "failed" } : {});
    const p1 = (await read("?status=failed")).body;
    expect(p1.requests).toEqual([]);
    expect(p1.nextCursor).toBe("r1000");
    const p2 = (await read(`?status=failed&cursor=${p1.nextCursor}`)).body;
    expect(p2.requests.map((r: Body) => r.id)).toEqual(["r1003"]);
    expect(p2.nextCursor).toBeNull();
  });

  it("channel and source filters", async () => {
    seedRow(SA, 1, { channel: "email", source: "broadcast" });
    seedRow(SA, 2, { channel: "sms", source: "inbox" });
    seedRow(SA, 3, { channel: "whatsapp_template" });
    expect((await read("?channel=whatsapp")).body.requests.map((r: Body) => r.id)).toEqual(["r003"]);
    expect((await read("?source=inbox")).body.requests.map((r: Body) => r.id)).toEqual(["r002"]);
    expect((await read("?source=dispatcher&channel=email")).body.requests).toEqual([]);
  });
});
