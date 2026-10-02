import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resend: vi.fn(),
  smtp: vi.fn(),
  credentials: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.resend };
  },
}));
vi.mock("./smtp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./smtp")>()),
  sendSmtpEmail: mocks.smtp,
  getSmtpConnection: mocks.credentials,
}));
vi.mock("@/lib/server/email-conversations", () => ({recordEmailMessage:vi.fn().mockResolvedValue({contactId:"contact",inserted:true})}));
vi.mock("@/lib/server/usage-meter", () => ({ recordUsage: mocks.usage }));
// Suppression has its own suite (email-suppression.test.ts); this one is about the provider call.
vi.mock("./email-suppression", () => ({ assertNotSuppressed: async () => undefined }));
vi.mock("@/lib/landing/resolve-brand", () => ({
  resolveCustomBrand: async () => ({ name: "LeadStack" }),
}));
import { emailIsConfigured, sendEmail } from "./resend";
const sub = {
  emailProvider: "smtp" as const,
  smtpConfig: {
    host: "smtp.example.com",
    port: 465,
    secure: true,
    username: "user",
    fromEmail: "sender@example.com",
    fromName: "Sender",
    verifiedAt: "2026-09-07T00:00:00Z",
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "");
  mocks.credentials.mockResolvedValue({
    ...sub.smtpConfig,
    password: "test-password",
  });
  mocks.smtp.mockResolvedValue({ id: "smtp-1" });
  mocks.resend.mockResolvedValue({ data: { id: "resend-1" } });
});
afterEach(() => vi.unstubAllEnvs());
it("recognizes configured SMTP without platform Resend", () => {
  expect(emailIsConfigured(sub)).toBe(true);
  expect(emailIsConfigured()).toBe(false);
  expect(emailIsConfigured({ emailProvider: "smtp" })).toBe(false);
});
it("sends using only the owning tenant's SMTP and meters success", async () => {
  const result = await sendEmail({
    to: "to@example.com",
    subject: "Hello",
    text: "Body",
    from: "wrong@resend.example",
    subAccount: sub,
    meter: { subAccountId: "sa1" },
  });
  expect(result.id).toBe("smtp-1");
  expect(mocks.credentials).toHaveBeenCalledWith("sa1");
  expect(mocks.smtp).toHaveBeenCalledWith(
    expect.objectContaining({ fromEmail: "sender@example.com" }),
    expect.objectContaining({
      to: "to@example.com",
      subject: "Hello",
      text: "Body",
      replyTo: "sender@example.com",
    })
  );
  expect(mocks.resend).not.toHaveBeenCalled();
  expect(mocks.usage).toHaveBeenCalledWith({
    subAccountId: "sa1",
    unit: "emailsSent",
    qty: 1,
  });
});
it("never falls back to Resend or meters a failed SMTP send", async () => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "shared@example.com");
  mocks.smtp.mockRejectedValue(new Error("SMTP unavailable"));
  await expect(
    sendEmail({
      to: "to@example.com",
      subject: "Hi",
      text: "Body",
      subAccount: sub,
      meter: { subAccountId: "sa1" },
    })
  ).rejects.toThrow("SMTP unavailable");
  expect(mocks.resend).not.toHaveBeenCalled();
  expect(mocks.usage).not.toHaveBeenCalled();
});
it("refuses SMTP without an explicit tenant identity", async () => {
  await expect(
    sendEmail({
      to: "to@example.com",
      subject: "Hi",
      text: "Body",
      subAccount: sub,
    })
  ).rejects.toThrow(/sub-account/i);
  expect(mocks.smtp).not.toHaveBeenCalled();
});
it("preserves shared Resend sending for unconfigured workspaces and platform mail", async () => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "shared@example.com");
  expect(emailIsConfigured()).toBe(true);
  expect(emailIsConfigured({ emailProvider: "smtp" })).toBe(false);
  await sendEmail({ to: "to@example.com", subject: "Hi", text: "Body" });
  expect(mocks.resend).toHaveBeenCalledWith(
    expect.objectContaining({ from: "shared@example.com" })
  );
  expect(mocks.smtp).not.toHaveBeenCalled();
});

it("keeps the workspace Reply-To and explicit override on SMTP", async () => {
  await sendEmail({
    to: "to@example.com",
    subject: "Hi",
    text: "Body",
    subAccount: { ...sub, replyToEmail: "inbox@example.com" },
    meter: { subAccountId: "sa1" },
  });
  expect(mocks.smtp).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ replyTo: "inbox@example.com" })
  );
  await sendEmail({
    to: "to@example.com",
    subject: "Hi",
    text: "Body",
    replyTo: "operator@example.com",
    subAccount: { ...sub, replyToEmail: "inbox@example.com" },
    meter: { subAccountId: "sa1" },
  });
  expect(mocks.smtp).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ replyTo: "operator@example.com" })
  );
});
