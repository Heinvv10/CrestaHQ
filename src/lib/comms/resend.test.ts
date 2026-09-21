import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  send: vi.fn(),
  record: vi.fn(),
  connection: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("./smtp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./smtp")>()),
  getSmtpConnection: m.connection,
  sendSmtpEmail: m.send,
}));
vi.mock("@/lib/server/email-conversations", () => ({
  recordEmailMessage: m.record,
}));
vi.mock("@/lib/server/usage-meter", () => ({ recordUsage: m.usage }));
// Suppression has its own suite (email-suppression.test.ts); this one is about the provider call.
vi.mock("./email-suppression", () => ({ assertNotSuppressed: async () => undefined }));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: vi.fn() }));
import { sendEmail } from "./resend";
const input = {
  to: "friend@example.com",
  subject: "Hi",
  text: "Hello",
  subAccount: { emailProvider: "smtp" as const },
  meter: { subAccountId: "sa" },
  inReplyTo: "<old@example.com>",
  references: ["<old@example.com>"],
  contactId: "contact",
  sentByUid: "user",
};
beforeEach(() => {
  vi.resetAllMocks();
  m.connection.mockResolvedValue({ fromEmail: "me@example.com" });
  m.send.mockResolvedValue({ id: "<sent@example.com>" });
  m.record.mockResolvedValue({ inserted: true, contactId: "contact" });
});
it("captures accepted SMTP delivery with RFC threading and tenant identity", async () => {
  expect(await sendEmail(input)).toMatchObject({
    id: "<sent@example.com>",
    saved: true,
  });
  expect(m.send).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      inReplyTo: input.inReplyTo,
      references: input.references,
    })
  );
  expect(m.record).toHaveBeenCalledWith(
    expect.objectContaining({
      subAccountId: "sa",
      contactId: "contact",
      sentByUid: "user",
      messageId: "<sent@example.com>",
      direction: "outbound",
      from: "me@example.com",
      to: [input.to],
      body: "Hello",
    })
  );
});
it("returns accepted save failure without throwing or retrying delivery", async () => {
  m.record.mockRejectedValue(new Error("database unavailable"));
  expect(await sendEmail(input)).toMatchObject({
    id: "<sent@example.com>",
    saved: false,
    warning: expect.stringContaining("sent"),
  });
  expect(m.send).toHaveBeenCalledTimes(1);
});
it("does not capture rejected SMTP delivery", async () => {
  m.send.mockRejectedValue(new Error("Rejected"));
  await expect(sendEmail(input)).rejects.toThrow("Rejected");
  expect(m.record).not.toHaveBeenCalled();
});
it("never archives private authentication or internal notifications", async () => {
  await sendEmail({ ...input, archive: false, text: "secret-login-token" });
  expect(m.record).not.toHaveBeenCalled();
  expect(m.send).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ archive: false })
  );
});
