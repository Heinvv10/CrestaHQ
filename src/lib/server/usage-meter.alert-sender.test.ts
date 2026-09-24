import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The quota alert to the agency owner is platform mail ABOUT one workspace.
 * With no shared sender it goes out through that workspace's own verified
 * SMTP; a workspace without one gets a logged "no email sender", never a
 * sibling's mailbox. Real usage meter + real `sendEmail` over an in-memory
 * Firestore; only the SMTP wire and the Resend client are faked.
 */

const s = () => import("@/test/email-suppression-seam");
const m = vi.hoisted(() => ({ resendSend: vi.fn(), smtpFor: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: m.resendSend };
  },
}));
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("@/lib/comms/smtp", async (orig) => ({
  ...(await (await s()).seamMocks.smtp(orig)),
  getSmtpConnection: async (subAccountId: string) => {
    m.smtpFor(subAccountId);
    return { fromEmail: `sender@${subAccountId}.test` };
  },
}));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({}) }));

const { AGENCY, SMTP_SUB, mem, smtpSend } = await s();
const { recordUsage } = await import("./usage-meter");

const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
const QUOTA = { usageQuotas: { smsSegmentsPerMonth: 10 } };

beforeEach(() => {
  mem.clear();
  smtpSend.mockClear();
  m.smtpFor.mockClear();
  m.resendSend.mockReset();
  errors.mockClear();
  process.env.RESEND_API_KEY = "";
  process.env.EMAIL_FROM = "";
  mem.seed(`agencies/${AGENCY}`, { ownerUid: "owner1" });
  mem.seed("users/owner1", { email: "owner@agency.test" });
  mem.seed("subAccounts/sa-mail", { ...SMTP_SUB, ...QUOTA });
  mem.seed("subAccounts/sa-sibling", { ...SMTP_SUB });
  mem.seed("subAccounts/sa-nomail", { agencyId: AGENCY, name: "No Mail Co", ...QUOTA });
});

describe("quota alert with no shared sender", () => {
  it("emails the agency owner through the capped workspace's own SMTP", async () => {
    await recordUsage({ subAccountId: "sa-mail", unit: "smsSegments", qty: 10 });
    await vi.waitFor(() => expect(smtpSend).toHaveBeenCalledTimes(1));
    expect(m.smtpFor.mock.calls).toEqual([["sa-mail"]]);
    expect(smtpSend.mock.calls[0][1].to).toBe("owner@agency.test");
    expect(m.resendSend).not.toHaveBeenCalled();
  });

  it("a workspace without SMTP is logged, not sent through a sibling", async () => {
    await recordUsage({ subAccountId: "sa-nomail", unit: "smsSegments", qty: 10 });
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("sub-account sa-nomail has no verified SMTP")),
    );
    expect(smtpSend).not.toHaveBeenCalled();
    expect(m.resendSend).not.toHaveBeenCalled();
  });
});
