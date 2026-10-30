import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one follow-up email a booker gets when their Google Meet room was made
 * after the confirmation said "the joining link will follow". Real service →
 * real sendEmail (sub-account SMTP, suppression list); only the SMTP wire is
 * faked.
 */

const s = () => import("@/test/email-suppression-seam");
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));

const { SA, AGENCY, mem, resetSeam, smtpSend, suppressionSeed } = await s();
const { sendMeetLinkFollowUp } = await import("./meet-link-follow-up");
const { MEET_LINK_NOT_EMAILED_NOTE } = await import("./meet-link-missing");

const MEET_LINK = "https://meet.google.com/abc-defg-hij";
const ts = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });
const start = new Date(Date.now() + 3 * 86_400_000);
const mails = () => smtpSend.mock.calls.map(([, m]) => m as unknown as { to: string; text: string; html: string });

beforeEach(() => {
  resetSeam();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mem.seed(`subAccounts/${SA}/bookingPages/p`, { slug: "p", name: "Intro", timezone: "UTC", durationMinutes: 30 });
  mem.seed("events/e1", {
    agencyId: AGENCY,
    subAccountId: SA,
    status: "scheduled",
    title: "Intro — Thandi",
    contactId: "c1",
    bookingPageSlug: "p",
    startAt: ts(start),
    endAt: ts(new Date(start.getTime() + 1_800_000)),
    meetingUrl: MEET_LINK,
  });
  mem.seed("contacts/c1", { name: "Thandi", email: "thandi@example.co.za", agencyId: AGENCY, subAccountId: SA });
  mem.seed("contacts/c1/activities/a1", { type: "meet_link_missing", content: "owed", meta: { eventId: "e1", pending: true } });
  mem.seed("contacts/c1/activities/a2", { type: "meet_link_missing", content: "other booking", meta: { eventId: "e9", pending: true } });
});

describe("sendMeetLinkFollowUp", () => {
  it("emails the booker the link once, and resolves that booking's timeline row only", async () => {
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mails()).toHaveLength(1);
    expect(mails()[0].to).toBe("thandi@example.co.za");
    expect(mails()[0].text).toContain(MEET_LINK);
    expect(mails()[0].html).toContain(`href="${MEET_LINK}"`);
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ meta: { eventId: "e1", resolved: true } });
    expect(mem.read("contacts/c1/activities/a2")).toMatchObject({ content: "other booking" });
    expect((mem.read("contacts/c1/activities/a2") as { meta: object }).meta).not.toHaveProperty("resolved");
  });

  it.each([
    ["the booking no longer holds that link", () => mem.seed("events/e1", { ...(mem.read("events/e1") as object), meetingUrl: "https://zoom.example/x" })],
    ["the booking was cancelled", () => mem.seed("events/e1", { ...(mem.read("events/e1") as object), status: "cancelled" })],
    ["the contact opted out of email", () => mem.seed("contacts/c1", { ...(mem.read("contacts/c1") as object), emailOptedOut: true })],
  ])("sends nothing when %s, and claims nothing", async (_l, setup) => {
    setup();
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mails()).toHaveLength(0);
    expect(mem.read("events/e1/reminderSends/meet-link-follow-up")).toBeUndefined();
    expect((mem.read("contacts/c1/activities/a1") as { meta: object }).meta).not.toHaveProperty("resolved");
  });

  it("the booking was cancelled: no email, no claim (guard on its own)", async () => {
    mem.seed("events/e1", { ...(mem.read("events/e1") as object), status: "cancelled" });
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mails()).toHaveLength(0);
    expect(mem.read("events/e1/reminderSends/meet-link-follow-up")).toBeUndefined();
  });

  it("a paid hold (awaiting payment) gets no follow-up: its confirmation, with the link, comes at mark-paid", async () => {
    mem.seed("events/e1", { ...(mem.read("events/e1") as object), status: "awaiting_payment" });
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mails()).toHaveLength(0);
    expect(mem.read("events/e1/reminderSends/meet-link-follow-up")).toBeUndefined();
  });

  it("the booking holds another link than the one made: no email, no claim, the row says not emailed (guard on its own)", async () => {
    await sendMeetLinkFollowUp("e1", "https://meet.google.com/some-other-room");
    expect(mails()).toHaveLength(0);
    expect(mem.read("events/e1/reminderSends/meet-link-follow-up")).toBeUndefined();
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ content: MEET_LINK_NOT_EMAILED_NOTE });
  });

  it("pinned to the reviewed address: sent when it still matches, withheld (row says so) when it doesn't", async () => {
    await sendMeetLinkFollowUp("e1", MEET_LINK, { pinnedEmail: "reviewed@example.co.za" });
    expect(mails()).toHaveLength(0);
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ content: MEET_LINK_NOT_EMAILED_NOTE });
    await sendMeetLinkFollowUp("e1", MEET_LINK, { pinnedEmail: "thandi@example.co.za" });
    expect(mails().map((m) => m.to)).toEqual(["thandi@example.co.za"]);
  });

  it("sending isn't configured: no email, and the row says the link exists but couldn't be emailed", async () => {
    mem.seed(`subAccounts/${SA}`, { agencyId: AGENCY });
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mails()).toHaveLength(0);
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ content: MEET_LINK_NOT_EMAILED_NOTE, meta: { pending: false } });
    expect(mem.read("events/e1/reminderSends/meet-link-follow-up")).toBeUndefined();
  });

  it("a booking without a usable start is checked before the claim: nothing claimed", async () => {
    mem.seed("events/e1", { ...(mem.read("events/e1") as object), startAt: null });
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mem.read("events/e1/reminderSends/meet-link-follow-up")).toBeUndefined();
  });

  it("a failed send: there is no retry, so the row tells an operator to send it, and nothing sends twice", async () => {
    smtpSend.mockRejectedValueOnce(Object.assign(new Error("421 try again later"), { responseCode: 421 }));
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ content: MEET_LINK_NOT_EMAILED_NOTE, meta: { pending: false } });
    expect(mem.read("events/e1/reminderSends/meet-link-follow-up")).toBeDefined();
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("nobody to email (pinnedEmail null): no email, and the row says the link couldn't be emailed", async () => {
    await sendMeetLinkFollowUp("e1", MEET_LINK, { pinnedEmail: null });
    expect(mails()).toHaveLength(0);
    expect(mem.read("contacts/c1/activities/a1")).toMatchObject({ content: MEET_LINK_NOT_EMAILED_NOTE, meta: { pending: false } });
  });

  it("a suppressed address: no email, the refusal on the timeline, the row left open", async () => {
    mem.seed(...suppressionSeed("thandi@example.co.za", SA));
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mails()).toHaveLength(0);
    expect(mem.list("contacts/c1/activities").some((a) => a.type === "email_suppressed")).toBe(true);
    expect((mem.read("contacts/c1/activities/a1") as { meta: object }).meta).not.toHaveProperty("resolved");
  });
});
