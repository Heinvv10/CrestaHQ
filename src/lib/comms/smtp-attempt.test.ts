import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 d1 — an SMTP send is a provider attempt only once `sendMail` was
 * called. Everything refused before connecting (headers, the address,
 * settings, DNS, a private IP) is not. Driven through sendEmail, the entry
 * every sender uses, with only DNS, nodemailer and the stored connection stubbed.
 */

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), sendMail: vi.fn(), close: vi.fn(), createTransport: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: vi.fn() }));
vi.mock("@/lib/server/usage-meter", () => ({ recordUsage: vi.fn() }));
// Suppression has its own suite (email-suppression.test.ts); this one is about the provider call.
vi.mock("./email-suppression", () => ({ assertNotSuppressed: async () => undefined }));
vi.mock("@/lib/server/email-conversations", () => ({ recordEmailMessage: vi.fn() }));
vi.mock("@/lib/landing/resolve-brand", () => ({ resolveCustomBrand: vi.fn() }));
const connection = vi.hoisted(() => ({
  host: "smtp.example.com", port: 587, secure: false, username: "user", password: "secret",
  fromEmail: "sender@example.com", fromName: "Sender",
}));
vi.mock("./smtp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./smtp")>()),
  getSmtpConnection: async () => connection,
}));

import { SmtpError } from "./smtp";
import { sendEmail } from "./resend";
import { providerAttempted } from "./provider-attempt";

const message = { to: "friend@example.com", subject: "Hi", text: "Hello" };
const sendSmtpEmail = (_c: unknown, msg: typeof message) =>
  sendEmail({ ...msg, subAccount: { emailProvider: "smtp" }, meter: { subAccountId: "sa" }, archive: false });
const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.createTransport.mockReturnValue(mocks);
});

describe("refused before connecting: not attempted", () => {
  it.each([
    ["a malformed address", () => ({ ...message, to: "not-an-address" })],
    ["a subject with a line break", () => ({ ...message, subject: "Hi\r\nBcc: x@example.com" })],
  ])("%s", async (_l, msg) => {
    const err = await caught(sendSmtpEmail(connection, msg()));
    expect(err).toBeInstanceOf(SmtpError);
    expect(providerAttempted(err)).toBe(false);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("an unresolvable host", async () => {
    mocks.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    const err = await caught(sendSmtpEmail(connection, message));
    expect((err as Error).message).toBe("SMTP hostname could not be resolved.");
    expect(providerAttempted(err)).toBe(false);
  });

  it("a host resolving to a private address", async () => {
    mocks.lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    expect(providerAttempted(await caught(sendSmtpEmail(connection, message)))).toBe(false);
  });
});

describe("sendMail was called: attempted, and the error is the same public one", () => {
  it("the server rejecting the message", async () => {
    mocks.sendMail.mockRejectedValue(Object.assign(new Error("530"), { code: "EAUTH" }));
    const err = await caught(sendSmtpEmail(connection, message));
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as SmtpError).message).toBe("SMTP authentication failed. Check the username and password.");
    expect((err as SmtpError).status).toBe(502);
    expect(providerAttempted(err)).toBe(true);
  });

  it("the server accepting nobody", async () => {
    mocks.sendMail.mockResolvedValue({ messageId: "<m@x>", accepted: [] });
    const err = await caught(sendSmtpEmail(connection, message));
    expect((err as Error).message).toBe("SMTP provider did not accept the message.");
    expect(providerAttempted(err)).toBe(true);
  });
});
