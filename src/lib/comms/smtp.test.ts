import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  verify: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: vi.fn() }));
import { validateSmtpInput, verifySmtpConnection, sendSmtpEmail } from "./smtp";
const input = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  username: "user",
  password: "secret",
  fromEmail: "sender@example.com",
  fromName: "Sender",
};
describe("SMTP transport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.createTransport.mockReturnValue(mocks);
    mocks.verify.mockResolvedValue(true);
  });
  it("validates TLS port pairings and credentials", () => {
    expect(validateSmtpInput(input).password).toBe("secret");
    for (const patch of [
      { port: 25 },
      { secure: true },
      { host: "http://host" },
      { fromEmail: "x\r\ny@example.com" },
      { password: "" },
    ])
      expect(() => validateSmtpInput({ ...input, ...patch })).toThrow();
  });
  it("retains a blank password only for the same authentication destination", () => {
    const prior = { ...input, verifiedAt: "now" };
    expect(validateSmtpInput({ ...input, password: "" }, prior).password).toBe(
      "secret"
    );
    expect(() =>
      validateSmtpInput({ ...input, password: "", username: "other" }, prior)
    ).toThrow();
  });
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "192.0.2.1",
  ])("rejects non-public DNS %s", async (address) => {
    mocks.lookup.mockResolvedValue([
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await expect(
      verifySmtpConnection({ ...input, verifiedAt: "now" })
    ).rejects.toThrow("public");
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });
  it("bounds DNS lookup time", async () => {
    vi.useFakeTimers();
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const result = expect(
      verifySmtpConnection({ ...input, verifiedAt: "now" })
    ).rejects.toThrow("resolved");
    await vi.advanceTimersByTimeAsync(10000);
    await result;
    vi.useRealTimers();
  });
  it("pins DNS and requires verified TLS, closes after verification", async () => {
    await verifySmtpConnection({ ...input, verifiedAt: "now" });
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "8.8.8.8",
        requireTLS: true,
        forceAuth: true,
        tls: {
          servername: "smtp.example.com",
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
        disableFileAccess: true,
        disableUrlAccess: true,
      })
    );
    expect(mocks.close).toHaveBeenCalled();
  });
  it("sanitizes provider failure and closes the connection", async () => {
    mocks.verify.mockRejectedValue(
      Object.assign(new Error("secret credential"), { code: "EAUTH" })
    );
    await expect(
      verifySmtpConnection({ ...input, verifiedAt: "now" })
    ).rejects.toThrow("authentication failed");
    expect(mocks.close).toHaveBeenCalled();
  });
  it("uses configured sender and decodes base64 attachment bytes", async () => {
    mocks.sendMail.mockResolvedValue({
      messageId: "id",
      accepted: ["to@example.com"],
    });
    expect(
      await sendSmtpEmail(
        { ...input, verifiedAt: "now" },
        {
          to: "to@example.com",
          subject: "Test",
          text: "Body",
          attachments: [{ filename: "invite.ics", content: "aGk=" }],
        }
      )
    ).toEqual({ id: "id" });
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { name: "Sender", address: "sender@example.com" },
        attachments: [
          {
            filename: "invite.ics",
            content: Buffer.from("hi"),
            contentType: undefined,
          },
        ],
      })
    );
  });
});
