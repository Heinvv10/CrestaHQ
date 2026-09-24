import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A deployment that sends only through per-sub-account SMTP has no shared
 * sender (RESEND_API_KEY unset). Platform mail about a sub-account — invites,
 * booking cancellations — must then go out through THAT sub-account's
 * verified SMTP, never another tenant's, and a missing sender is logged
 * rather than skipped silently. Runs the real `sendEmail` over an in-memory
 * Firestore; only the SMTP wire and the Resend client are faked.
 */

const s = () => import("@/test/email-suppression-seam");
const m = vi.hoisted(() => ({
  resendSend: vi.fn(),
  smtpFor: vi.fn(),
  recordUsage: vi.fn(),
  existing: null as null | { uid: string; email: string; emailVerified: boolean },
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: m.resendSend };
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
vi.mock("@/lib/comms/smtp", async (orig) => ({
  ...(await (await s()).seamMocks.smtp(orig)),
  // Which mailbox the send went out through.
  getSmtpConnection: async (subAccountId: string) => {
    m.smtpFor(subAccountId);
    return { fromEmail: `sender@${subAccountId}.test` };
  },
}));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => ({
  ...(await (await s()).seamMocks.usage(orig)),
  recordUsage: m.recordUsage,
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/landing/resolve-brand", () => ({
  resolveBrandName: async () => "LeadStack",
  resolveCustomBrand: async () => ({}),
}));
vi.mock("@/lib/booking/lifecycle", () => ({
  fireBookingTrigger: async () => undefined,
  recordBookingActivity: async () => undefined,
}));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: async () => undefined }));

const { SA, SMTP_SUB, mem, resetSeam, smtpSend } = await s();
const { createInviteServerSide } = await import("@/lib/server/members-service");
const { changeEventStatus } = await import("@/lib/server/event-status-service");
const { resolvePlatformSender } = await import("./platform-email");

const OTHER = "sa-other";
const NO_SMTP = "sa-nosmtp";
const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

const invite = (subAccountId: string, email = "new@example.com") =>
  createInviteServerSide({
    subAccountId,
    invitedByUid: "admin1",
    auditActor: { type: "user", id: "admin1" },
    email,
    role: "collaborator",
  });

beforeEach(() => {
  resetSeam();
  mem.seed(`subAccounts/${OTHER}`, { ...SMTP_SUB, name: "Other Co" });
  mem.seed(`subAccounts/${NO_SMTP}`, { agencyId: SMTP_SUB.agencyId, name: "No Mail Co" });
  mem.seed("users/admin1", { email: "admin@tenant.test", displayName: "Admin" });
  m.existing = null;
  m.resendSend.mockReset();
  m.resendSend.mockResolvedValue({ data: { id: "resend-1" }, error: null });
  m.smtpFor.mockClear();
  m.recordUsage.mockClear();
  errors.mockClear();
  process.env.RESEND_API_KEY = "";
  process.env.EMAIL_FROM = "";
});
afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

describe("member invite with no shared sender", () => {
  it("goes out through the invited sub-account's own SMTP, unmetered", async () => {
    const res = await invite(SA);
    expect(res).toMatchObject({ mailed: true, mailError: null });
    expect(m.smtpFor.mock.calls).toEqual([[SA]]);
    expect(smtpSend.mock.calls.map(([, msg]) => msg.to)).toEqual(["new@example.com"]);
    expect(m.resendSend).not.toHaveBeenCalled();
    // Platform mail is not client spend.
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("an added existing user is notified through the same sub-account's SMTP", async () => {
    m.existing = { uid: "u2", email: "known@example.com", emailVerified: true };
    const res = await invite(OTHER, "known@example.com");
    expect(res).toMatchObject({ added: true, mailed: true });
    expect(m.smtpFor.mock.calls).toEqual([[OTHER]]);
  });

  it("a sub-account without SMTP is not emailed through a sibling's mailbox; logged, invite kept", async () => {
    const res = await invite(NO_SMTP);
    expect(res.mailed).toBe(false);
    expect(res.mailError).toContain("No email sender");
    expect(smtpSend).not.toHaveBeenCalled();
    expect(m.resendSend).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`sub-account ${NO_SMTP} has no verified SMTP`));
    expect(mem.list("invites")).toHaveLength(1);
  });
});

describe("shared sender configured", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "platform@example.com";
  });

  it("is preferred over the sub-account's SMTP", async () => {
    const res = await invite(SA);
    expect(res.mailed).toBe(true);
    expect(m.resendSend).toHaveBeenCalledTimes(1);
    expect(smtpSend).not.toHaveBeenCalled();
  });

  it("resolves to shared even with no sub-account", async () => {
    await expect(resolvePlatformSender(null)).resolves.toEqual({ kind: "shared" });
  });
});

describe("resolvePlatformSender with no shared sender", () => {
  it("never resolves without a sub-account, nor for one lacking verified SMTP", async () => {
    await expect(resolvePlatformSender(null)).resolves.toBeNull();
    await expect(resolvePlatformSender(NO_SMTP)).resolves.toBeNull();
    mem.seed(`subAccounts/unverified`, {
      ...SMTP_SUB,
      smtpConfig: { ...SMTP_SUB.smtpConfig, verifiedAt: null },
    });
    await expect(resolvePlatformSender("unverified")).resolves.toBeNull();
  });

  it("resolves to that sub-account's own SMTP", async () => {
    await expect(resolvePlatformSender(OTHER)).resolves.toMatchObject({ kind: "smtp", subAccountId: OTHER });
  });
});

describe("operator booking cancel with no shared sender", () => {
  const ts = (iso: string) => ({ toDate: () => new Date(iso) }) as never;
  it("emails the visitor through the booking sub-account's SMTP", async () => {
    mem.seed("contacts/c1", { subAccountId: SA, name: "Visitor", email: "visitor@example.com" });
    mem.seed("events/e1", { subAccountId: SA, status: "scheduled" });
    const outcome = await changeEventStatus(
      {
        id: "e1",
        title: "Meeting",
        startAt: ts("2030-01-01T10:00:00Z"),
        endAt: ts("2030-01-01T10:30:00Z"),
        contactId: "c1",
        location: "",
        notes: "",
        agencyId: SMTP_SUB.agencyId,
        subAccountId: SA,
        createdByUid: "u1",
        status: "scheduled",
        createdAt: null,
        updatedAt: null,
      },
      "cancelled",
    );
    expect(outcome.emailSent).toBe(true);
    expect(m.smtpFor.mock.calls).toEqual([[SA]]);
    expect(smtpSend.mock.calls.map(([, msg]) => msg.to)).toEqual(["visitor@example.com"]);
    expect(m.resendSend).not.toHaveBeenCalled();
  });
});
