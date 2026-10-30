import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

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
vi.mock("./smtp", async (orig) => (await s()).seamMocks.smtp(orig));
vi.mock("@/lib/server/email-conversations", async () => (await s()).seamMocks.conversations());
vi.mock("@/lib/server/usage-meter", async (orig) => (await s()).seamMocks.usage(orig));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: async () => ({ name: "LeadStack" }) }));

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

  it("matches regardless of case", async () => {
    suppress("Gone@Example.com");
    await expect(smtp("GONE@example.COM")).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(wireRecipients()).toEqual([]);
  });

  it.each(["Gone <gone@example.com>", " gone@example.com", "gone@example.com, x@example.com"])(
    "refuses a recipient that is not a bare address (%s) on both rails",
    async (to) => {
      suppress("gone@example.com");
      await expect(smtp(to)).rejects.toThrow("Invalid recipient email address.");
      await expect(
        sendEmail({ to, subject: "Hi", text: "Hello", meter: { subAccountId: SA } })
      ).rejects.toThrow("Invalid recipient email address.");
      expect(wireRecipients()).toEqual([]);
      await flushAfterResponse();
      expect(resend.send).not.toHaveBeenCalled();
    }
  );

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
    await flushAfterResponse();
    expect(resend.send).not.toHaveBeenCalled();
  });

  it("does not check deployment mail that names no sub-account", async () => {
    suppress("gone@example.com");
    await sendEmail({ to: "gone@example.com", subject: "Invite", text: "Join" });
    await flushAfterResponse();
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
