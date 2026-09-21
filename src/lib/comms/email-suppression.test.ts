import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared send helper refuses a suppressed address before any provider is
 * called. Every per-path test (workflow, broadcast, inbox, quote, booking)
 * relies on this one check; these pin its scoping.
 */

const s = () => import("@/test/email-suppression-seam");
const resend = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resend.send };
  },
}));
vi.mock("@/lib/firebase/admin", async () => (await s()).seamMocks.admin());
vi.mock("./smtp", async () => (await s()).seamMocks.smtp());
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({}) }));

const { SA, SMTP_SUB, mem, resetSeam, suppress, wireRecipients } = await s();
const { sendEmail } = await import("./resend");
const { EmailSuppressedError } = await import("./email-suppression");

const smtp = (to: string, subAccountId = SA) =>
  sendEmail({
    to,
    subject: "Hi",
    text: "Hello",
    subAccount: SMTP_SUB as never,
    meter: { subAccountId },
  });

beforeEach(() => {
  resetSeam();
  resend.send.mockReset();
  resend.send.mockResolvedValue({ data: { id: "resend-1" }, error: null });
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "platform@example.com";
});

describe("sendEmail suppression", () => {
  it("refuses a suppressed address with a reason before the SMTP wire", async () => {
    suppress("gone@example.com");
    const err = await smtp("gone@example.com").catch((e) => e);
    expect(err).toBeInstanceOf(EmailSuppressedError);
    expect(err.message).toContain("gone@example.com");
    expect(err.message).toContain("hard bounce");
    expect(wireRecipients()).toEqual([]);
  });

  it("matches regardless of case and surrounding whitespace", async () => {
    suppress("Gone@Example.com");
    await expect(smtp("  GONE@example.COM ")).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(wireRecipients()).toEqual([]);
  });

  it("still sends to an address that is not suppressed", async () => {
    suppress("gone@example.com");
    await smtp("fine@example.com");
    expect(wireRecipients()).toEqual(["fine@example.com"]);
  });

  it("is per sub-account: another workspace's list does not apply", async () => {
    mem.seed("subAccounts/sa2", SMTP_SUB);
    suppress("gone@example.com", "sa2");
    await smtp("gone@example.com", SA);
    expect(wireRecipients()).toEqual(["gone@example.com"]);
  });

  it("refuses on the Resend rail too", async () => {
    suppress("gone@example.com");
    await expect(
      sendEmail({ to: "gone@example.com", subject: "Hi", text: "Hello", meter: { subAccountId: SA } })
    ).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(resend.send).not.toHaveBeenCalled();
  });

  it("does not check deployment mail that names no sub-account", async () => {
    suppress("gone@example.com");
    await sendEmail({ to: "gone@example.com", subject: "Invite", text: "Join" });
    expect(resend.send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the lookup itself fails", async () => {
    const get = vi.spyOn(mem.db, "doc").mockImplementationOnce(() => {
      throw new Error("firestore unavailable");
    });
    await expect(smtp("fine@example.com")).rejects.toThrow("firestore unavailable");
    expect(wireRecipients()).toEqual([]);
    get.mockRestore();
  });
});
