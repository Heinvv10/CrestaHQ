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

  it("a suppressed address: no email, the refusal on the timeline, the row left open", async () => {
    mem.seed(...suppressionSeed("thandi@example.co.za", SA));
    await sendMeetLinkFollowUp("e1", MEET_LINK);
    expect(mails()).toHaveLength(0);
    expect(mem.list("contacts/c1/activities").some((a) => a.type === "email_suppressed")).toBe(true);
    expect((mem.read("contacts/c1/activities/a1") as { meta: object }).meta).not.toHaveProperty("resolved");
  });
});
