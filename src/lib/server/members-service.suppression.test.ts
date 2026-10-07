import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Member invites and "you've been added" emails are addressed on a
 * sub-account's behalf, so its suppression list applies even though they are
 * unmetered platform mail. Access is still granted; only the email is
 * withheld, and `mailSuppressed` tells the inviter why.
 */

const s = () => import("@/test/email-suppression-seam");
const m = vi.hoisted(() => ({ send: vi.fn(), existing: null as null | { uid: string; email: string; emailVerified: boolean } }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: m.send };
  },
}));
vi.mock("@/lib/firebase/admin", async () => ({
  ...(await s()).seamMocks.admin(),
  getAdminAuth: () => ({
    getUserByEmail: async () => {
      if (m.existing) return m.existing;
      throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
    },
  }),
}));
vi.mock("@/lib/comms/smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/landing/resolve-brand", () => ({
  resolveCustomBrand: async () => ({ name: "LeadStack" }),
}));

const { SA, AGENCY, mem, resetSeam, smtpSend, suppress } = await s();
const { createInviteServerSide } = await import("./members-service");

const invite = (email: string) =>
  createInviteServerSide({
    subAccountId: SA,
    invitedByUid: "admin1",
    auditActor: { type: "user", id: "admin1" },
    email,
    role: "collaborator",
  });
const sentTo = () => m.send.mock.calls.map(([msg]) => (msg as { to: string }).to);

beforeEach(() => {
  resetSeam();
  mem.seed("users/admin1", { email: "admin@tenant.test", displayName: "Admin" });
  m.existing = null;
  m.send.mockReset();
  m.send.mockResolvedValue({ data: { id: "resend-1" }, error: null });
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "platform@example.com";
});

describe("new-person invite", () => {
  it("emails an address that is not suppressed", async () => {
    const res = await invite("new@example.com");
    expect(res).toMatchObject({ mailed: true, mailSuppressed: false });
    expect(sentTo()).toEqual(["new@example.com"]);
  });

  it("creates the invite but withholds the email from a suppressed address", async () => {
    suppress("new@example.com");
    const res = await invite("new@example.com");
    expect(res).toMatchObject({ mailed: false, mailSuppressed: true });
    expect(res.mailError).toContain("suppression list");
    expect(sentTo()).toEqual([]);
    expect(mem.list("invites")).toHaveLength(1);
  });
});

describe("existing user added directly", () => {
  beforeEach(() => {
    m.existing = { uid: "u2", email: "known@example.com", emailVerified: true };
  });

  it("emails an address that is not suppressed", async () => {
    const res = await invite("known@example.com");
    expect(res).toMatchObject({ added: true, mailed: true, mailSuppressed: false });
    expect(sentTo()).toEqual(["known@example.com"]);
  });

  it("adds the member but withholds the email from a suppressed address", async () => {
    suppress("known@example.com");
    const res = await invite("known@example.com");
    expect(res).toMatchObject({ added: true, mailed: false, mailSuppressed: true });
    expect(sentTo()).toEqual([]);
    expect(mem.read(`subAccounts/${SA}/subAccountMembers/u2`)).toMatchObject({ status: "active" });
  });
});

/**
 * Shared rail: From is send-only, so Reply-To is the inviter. SMTP rail: From
 * is the agency mailbox and an inviter Reply-To on another domain scores
 * FROM_NOT_REPLYTO, so the platform default (agency support) applies.
 */
describe.each([
  ["new-person invite", "new@example.com", false],
  ["added-member email", "known@example.com", true],
])("Reply-To on the %s", (_name, to, existing) => {
  const inviter = "admin@tenant.test";

  beforeEach(() => {
    if (existing) m.existing = { uid: "u2", email: to, emailVerified: true };
    mem.seed(`agencies/${AGENCY}`, { supportEmail: "support@agency.test" });
  });

  it("shared rail: replies go to the inviter", async () => {
    await invite(to);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect((m.send.mock.calls[0][0] as { replyTo?: string }).replyTo).toBe(inviter);
  });

  it("SMTP rail: the agency support address, not the inviter's", async () => {
    delete process.env.RESEND_API_KEY;
    await invite(to);
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect((smtpSend.mock.calls[0][1] as { replyTo?: string }).replyTo).toBe("support@agency.test");
  });
});
