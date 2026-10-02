import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The subscription checkout link ("sendLink"), on a deployment with no shared
 * sender, is emailed through THAT sub-account's verified SMTP with replies to
 * the agency; without SMTP it is not emailed (logged) and the link is still
 * returned. Real `sendEmail` over an in-memory Firestore; auth, the link mint
 * and the SMTP wire are faked.
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
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({ name: "LeadStack" }) }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "owner1", agencyId: "ag1", subAccountRole: "agencyOwner" }),
}));
vi.mock("@/lib/server/billing-service", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  mintCheckoutLink: async () => "https://app.test/pay/sub/x",
}));

const { SA, mem, resetSeam, smtpSend } = await s();
const { PATCH } = await import("./route");

const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
const sendLink = (subAccountId: string) =>
  PATCH(
    new Request("https://app.test", {
      method: "PATCH",
      body: JSON.stringify({ action: "sendLink", emailTo: "client@example.com" }),
    }),
    { params: Promise.resolve({ id: subAccountId }) },
  );

beforeEach(() => {
  resetSeam();
  mem.seed("subAccounts/sa-nomail", { agencyId: "ag1", name: "No Mail Co" });
  mem.seed("agencies/ag1", { ownerUid: "owner1", supportEmail: "help@agency.test" });
  m.smtpFor.mockClear();
  m.resendSend.mockReset();
  errors.mockClear();
  process.env.RESEND_API_KEY = "";
  process.env.EMAIL_FROM = "";
});

describe("subscription checkout-link email with no shared sender", () => {
  it("goes out through the billed sub-account's SMTP, replies to the agency", async () => {
    const res = await sendLink(SA);
    expect(await res.json()).toMatchObject({ ok: true, emailed: true });
    expect(m.smtpFor.mock.calls).toEqual([[SA]]);
    const msg = smtpSend.mock.calls[0][1] as { to: string; replyTo?: string };
    expect(msg).toMatchObject({ to: "client@example.com", replyTo: "help@agency.test" });
    expect(m.resendSend).not.toHaveBeenCalled();
  });

  it("escapes the sub-account and plan names in the HTML body", async () => {
    mem.seed(`subAccounts/${SA}`, {
      ...(mem.read(`subAccounts/${SA}`) as Record<string, unknown>),
      name: `<b>Acme</b>`,
      billing: { planName: `Pro"><img src=x>`, priceCents: 1000, currency: "usd", billingInterval: "month" },
    });
    await sendLink(SA);
    const html = (smtpSend.mock.calls[0][1] as { to: string; html?: string }).html ?? "";
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(html).toContain("Pro&quot;&gt;&lt;img src=x&gt;");
    expect(html).not.toContain("<b>Acme");
    expect(html).not.toContain("<img");
  });

  it("a sub-account without SMTP: link returned, not emailed, logged", async () => {
    const res = await sendLink("sa-nomail");
    expect(await res.json()).toMatchObject({ ok: true, emailed: false, checkoutUrl: expect.any(String) });
    expect(smtpSend).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("sub-account sa-nomail has no verified SMTP"));
  });
});
