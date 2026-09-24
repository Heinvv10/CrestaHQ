import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A charge link for a sub-account, on a deployment with no shared sender,
 * is emailed through THAT sub-account's verified SMTP; without one it is not
 * emailed (logged), and the link is still returned. Real `sendEmail` over an
 * in-memory Firestore; auth, the charge write and the SMTP wire are faked.
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
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({}) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "owner1", agencyId: "ag1", subAccountRole: "agencyOwner" }),
}));
vi.mock("@/lib/server/billing-service", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createOneTimeCharge: async () => ({ charge: { id: "ch1" }, checkoutUrl: "https://app.test/pay/charge/ch1" }),
}));

const { SA, mem, resetSeam, smtpSend } = await s();
const { POST } = await import("./route");

const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
const post = (subAccountId: string) =>
  POST(
    new Request("https://app.test", {
      method: "POST",
      body: JSON.stringify({ description: "Web design", amountCents: 5000, emailTo: "client@example.com" }),
    }),
    { params: Promise.resolve({ id: subAccountId }) },
  );

beforeEach(() => {
  resetSeam();
  mem.seed("subAccounts/sa-nomail", { agencyId: "ag1", name: "No Mail Co" });
  m.smtpFor.mockClear();
  m.resendSend.mockReset();
  errors.mockClear();
  process.env.RESEND_API_KEY = "";
  process.env.EMAIL_FROM = "";
});

describe("charge-link email with no shared sender", () => {
  it("goes out through the charged sub-account's SMTP", async () => {
    const res = await post(SA);
    expect(await res.json()).toMatchObject({ ok: true, emailed: true });
    expect(m.smtpFor.mock.calls).toEqual([[SA]]);
    expect(smtpSend.mock.calls[0][1].to).toBe("client@example.com");
    expect(m.resendSend).not.toHaveBeenCalled();
  });

  it("a sub-account without SMTP: link returned, not emailed, logged", async () => {
    const res = await post("sa-nomail");
    expect(await res.json()).toMatchObject({ ok: true, emailed: false, checkoutUrl: expect.any(String) });
    expect(smtpSend).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("sub-account sa-nomail has no verified SMTP"));
  });
});
