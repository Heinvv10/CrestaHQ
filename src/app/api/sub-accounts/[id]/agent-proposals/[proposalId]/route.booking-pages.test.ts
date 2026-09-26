import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { PAGE, pageForm } from "@/test/booking-fixtures";

/**
 * The PR12 booking-page capabilities through the real dispatch and decide
 * route, with the booking-page routes' own checks: a draft is created and
 * edited directly (stamped); anything the public sees on a published page
 * is a public_change proposal showing old -> new, re-checked in the write's
 * transaction; a delete is refused while bookings are upcoming.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const LIVE = { ...PAGE, id: "live", slug: "live", name: "Live consult", status: "published" };
const P = "subAccounts/sa1/bookingPages";
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
async function proposeId(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(name, args);
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
const booking = (ms: number, slug = "bp1") => mem.seed(`events/ev_${slug}`, { subAccountId: "sa1", bookingPageSlug: slug, startAt: Timestamp.fromMillis(Date.now() + ms) });

beforeEach(() => {
  mem.seed(`${P}/bp1`, PAGE);
  mem.seed(`${P}/live`, LIVE);
});

describe("create_booking_page", () => {
  it("a draft: created directly through the route's checks, stamped", async () => {
    expect(await call("create_booking_page", pageForm("intro", { name: "Intro call" }))).toMatchObject({ ok: true });
    expect(mem.read(`${P}/intro`)).toMatchObject({ slug: "intro", name: "Intro call", status: "draft", subAccountId: "sa1", territoryId: "global", lastAgentEditKey: "abcd1234" });
  });

  it("published: a public_change proposal showing the page, nothing written; approve creates it", async () => {
    const id = await proposeId("create_booking_page", pageForm("intro", { name: "Intro call", status: "published" }));
    expect(row(id).approval).toBe("public_change");
    expect(rowOf(id, "name")).toBe("Intro call");
    expect(rowOf(id, "status")).toBe("published");
    expect(mem.read(`${P}/intro`)).toBeUndefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read(`${P}/intro`)).toMatchObject({ status: "published", name: "Intro call" });
  });

  it.each([
    ["a taken slug", pageForm("bp1", { name: "Other" }), "A booking page with the slug \"bp1\" already exists. Pick another."],
    ["another page's name in capitals", pageForm("intro", { name: "CONSULT" }), "The name is the same as, or looks like, an existing one (another booking page's)."],
    ["a deposit with no payment rail", pageForm("intro", { name: "Paid", payment: { amount: 100, currency: "USD", description: null, holdHours: 24 } }), "Connect Stripe or PayPal under Settings \u2192 Payments first. A booking page can't require a deposit until then."],
  ])("%s -> refused", async (_label, args, message) => {
    const r = await call("create_booking_page", args);
    expect(r).toMatchObject({ ok: false, ...(message ? { message } : {}) });
    expect(mem.read(`${P}/intro`)).toBeUndefined();
  });

  it("a host renamed after the approver's preview check -> failed, not created", async () => {
    mem.seed("subAccounts/sa1/subAccountMembers/u2", { uid: "u2", status: "active", displayName: "Bea" });
    const id = await proposeId("create_booking_page", pageForm("intro", { name: "Intro call", status: "published", hosts: [{ uid: "u2", name: "B" }] }));
    expect(rowOf(id, "hosts")).toContain("Bea");
    beforeNextTransaction(async () => mem.seed("subAccounts/sa1/subAccountMembers/u2", { uid: "u2", status: "active", displayName: "Bea Q" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read(`${P}/intro`)).toBeUndefined();
  });

  it("the capability refuses an unapproved published create itself", async () => {
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1" };
    await expect(getCapability("create_booking_page")!.execute(ctx, pageForm("intro", { name: "Intro call", status: "published" }))).rejects.toThrow("A published page needs approval: send it again.");
    expect(mem.read(`${P}/intro`)).toBeUndefined();
  });

  it("a name made of look-alike letters -> invalid args", async () => {
    expect(await call("create_booking_page", pageForm("intro", { name: "B\u0430nk call" }))).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("an invisible character in the confirmation text -> invalid args", async () => {
    expect(await call("create_booking_page", pageForm("intro", { confirmationMessage: "See you\u200b" }))).toMatchObject({ ok: false, code: "invalid_args" });
  });
});

describe("update_booking_page", () => {
  it("a draft: written directly, stamped, slug unchanged", async () => {
    expect(await call("update_booking_page", { slug: "bp1", durationMinutes: 45 })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/bp1`)).toMatchObject({ durationMinutes: 45, slug: "bp1", lastAgentEditKey: "abcd1234" });
  });

  it("a published page: a public_change proposal with only the changed fields old -> new; approve applies", async () => {
    const id = await proposeId("update_booking_page", { slug: "live", durationMinutes: 45, confirmationMessage: "See you soon" });
    expect(row(id).approval).toBe("public_change");
    expect(rowOf(id, "durationMinutes")).toBe(`${LIVE.durationMinutes} \u2192 45`);
    expect(rowOf(id, "confirmationMessage")).toMatch(/\u2192 See you soon$/);
    expect(rowOf(id, "name")).toBeUndefined();
    expect(mem.read(`${P}/live`)!.durationMinutes).toBe(LIVE.durationMinutes);
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read(`${P}/live`)).toMatchObject({ durationMinutes: 45, confirmationMessage: "See you soon" });
  });

  it("a host renamed after the approver's preview check of an edit -> failed, unchanged", async () => {
    mem.seed("subAccounts/sa1/subAccountMembers/u2", { uid: "u2", status: "active", displayName: "Bea" });
    const id = await proposeId("update_booking_page", { slug: "live", hosts: [{ uid: "u2", name: "B" }] });
    beforeNextTransaction(async () => mem.seed("subAccounts/sa1/subAccountMembers/u2", { uid: "u2", status: "active", displayName: "Bea Q" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read(`${P}/live`)!.hosts ?? []).toEqual(LIVE.hosts ?? []);
  });

  it("publishing a draft is a proposal too", async () => {
    expect(row(await proposeId("update_booking_page", { slug: "bp1", status: "published" })).approval).toBe("public_change");
  });

  it("the published page edited inside the approved write's transaction -> failed, unchanged", async () => {
    const id = await proposeId("update_booking_page", { slug: "live", durationMinutes: 45 });
    beforeNextTransaction(async () => beforeNextTransaction(async () => mem.seed(`${P}/live`, { ...LIVE, visibleDays: 3 })));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read(`${P}/live`)).toMatchObject({ visibleDays: 3, durationMinutes: LIVE.durationMinutes });
  });

  it("a draft published between the agent's read and its write -> refused, unchanged", async () => {
    beforeNextTransaction(async () => mem.seed(`${P}/bp1`, { ...PAGE, status: "published" }));
    expect(await call("update_booking_page", { slug: "bp1", durationMinutes: 45 })).toMatchObject({
      ok: false, message: "This page is published, the edit publishes it, or bookings on it are upcoming, so the change needs approval: send it again.",
    });
    expect(mem.read(`${P}/bp1`)!.durationMinutes).toBe(PAGE.durationMinutes);
  });

  it("a draft with an upcoming booking (its reminders read the page): a meeting-link and name edit is a proposal, nothing written", async () => {
    booking(86_400_000);
    const id = await proposeId("update_booking_page", { slug: "bp1", meetingUrl: "https://meet.example/new", name: "Consult (new)" });
    expect(row(id).approval).toBe("public_change");
    expect(rowOf(id, "meetingUrl")).toBe("https://meet.example/new");
    expect(rowOf(id, "Changed")).toEqual(expect.stringContaining("meetingUrl"));
    expect(mem.read(`${P}/bp1`)).toEqual(PAGE);
  });

  it("a booking made on a draft between the agent's read and its write -> refused, unchanged", async () => {
    beforeNextTransaction(async () => booking(86_400_000));
    expect(await call("update_booking_page", { slug: "bp1", durationMinutes: 45 })).toMatchObject({
      ok: false, message: "This page is published, the edit publishes it, or bookings on it are upcoming, so the change needs approval: send it again.",
    });
    expect(mem.read(`${P}/bp1`)).toEqual(PAGE);
  });

  it("a draft edited directly, then published: the publish proposal shows the whole page, earlier edits included", async () => {
    expect(await call("update_booking_page", { slug: "bp1", confirmationMessage: "Pay the deposit to acct 999" })).toMatchObject({ ok: true });
    const id = await proposeId("update_booking_page", { slug: "bp1", status: "published" });
    expect(rowOf(id, "Changed")).toBe("status");
    expect(rowOf(id, "confirmationMessage")).toBe("Pay the deposit to acct 999");
    expect(rowOf(id, "name")).toBe("Consult");
  });

  it("an edit of a page with upcoming bookings shows the whole page too", async () => {
    booking(86_400_000);
    const id = await proposeId("update_booking_page", { slug: "bp1", durationMinutes: 45 });
    expect(rowOf(id, "Changed")).toEqual(expect.stringContaining("durationMinutes"));
    expect(rowOf(id, "name")).toBe("Consult");
  });

  it("a default territory that isn't this sub-account's -> refused; one that is -> fine", async () => {
    mem.seed("subAccounts/sa1/territories/north", { name: "North" });
    expect(await call("update_booking_page", { slug: "bp1", defaultTerritoryId: "t_foreign" })).toMatchObject({ ok: false, message: "That default territory isn't in this workspace." });
    expect(await call("create_booking_page", pageForm("intro", { name: "Intro", defaultTerritoryId: "t_foreign" }))).toMatchObject({ ok: false, message: "That default territory isn't in this workspace." });
    expect(await call("update_booking_page", { slug: "bp1", defaultTerritoryId: "north" })).toMatchObject({ ok: true });
  });

  it("a draft whose bookings are all past is still edited directly", async () => {
    booking(-86_400_000);
    expect(await call("update_booking_page", { slug: "bp1", durationMinutes: 45 })).toMatchObject({ ok: true });
  });

  it("the slug can't be changed; unknown pages are refused", async () => {
    expect(await call("update_booking_page", { slug: "nope", durationMinutes: 45 })).toMatchObject({ ok: false, message: "That booking page isn't in this workspace." });
  });
});

describe("delete_booking_page", () => {
  it("a hard_delete proposal showing the whole page; approve deletes it", async () => {
    booking(-86_400_000);
    const id = await proposeId("delete_booking_page", { slug: "bp1" });
    expect(row(id).approval).toBe("hard_delete");
    expect(rowOf(id, "Delete booking page")).toBe("Consult (/bp1), draft");
    expect(rowOf(id, "workingHours")).toBeDefined();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read(`${P}/bp1`)).toBeUndefined();
  });

  it("a booking in progress (started, not yet over) blocks the delete", async () => {
    mem.seed("events/ev_now", { subAccountId: "sa1", bookingPageSlug: "bp1", startAt: Timestamp.fromMillis(Date.now() - 600_000), endAt: Timestamp.fromMillis(Date.now() + 600_000) });
    expect(await call("delete_booking_page", { slug: "bp1" })).toMatchObject({ ok: false, message: expect.stringContaining("1 upcoming booking(s)") });
  });

  it("an upcoming booking -> refused at propose", async () => {
    booking(86_400_000);
    expect(await call("delete_booking_page", { slug: "bp1" })).toMatchObject({ ok: false, message: expect.stringContaining("1 upcoming booking(s)") });
  });

  it("a booking made inside the delete's transaction -> failed, kept", async () => {
    const id = await proposeId("delete_booking_page", { slug: "bp1" });
    beforeNextTransaction(async () => beforeNextTransaction(async () => booking(86_400_000)));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read(`${P}/bp1`)).toBeDefined();
  });
});

describe("list / get", () => {
  it("list shows slug, status and length; get shows the fields", async () => {
    expect(await call("list_booking_pages", {})).toMatchObject({ ok: true, resultText: expect.stringContaining("slug: live, published") });
    expect(await call("get_booking_page", { slug: "bp1" })).toMatchObject({ ok: true, resultText: expect.stringContaining("name: Consult") });
  });
});
