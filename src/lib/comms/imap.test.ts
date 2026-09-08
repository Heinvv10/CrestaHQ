import { describe, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { lookup } from "node:dns/promises";
import {
  validateMailboxInput,
  resolveMailboxHost,
  parseMailboxMessage,
  discoverSentFolder,
} from "./imap";
const input = {
  host: "mail.example.com",
  port: 993,
  username: "me@example.com",
  password: "secret",
  useSmtpCredentials: false,
};
describe("mailbox safety", () => {
  it("preserves recipients inside named address groups", async () => {
    const mail = await parseMailboxMessage(
      Buffer.from(
        "From: me@example.com\r\nTo: Team: a@example.com, b@example.com;\r\n\r\nHello"
      )
    );
    expect(mail.to).toEqual(["a@example.com", "b@example.com"]);
  });
  it("requires TLS993 and explicit matching SMTP reuse", () => {
    expect(() => validateMailboxInput({ ...input, port: 143 })).toThrow();
    expect(() =>
      validateMailboxInput(
        { ...input, password: "", useSmtpCredentials: true },
        { ...input, host: "other.example.com" } as never
      )
    ).toThrow();
    expect(validateMailboxInput(input).password).toBe("secret");
  });
  it("rejects mixed public/private DNS", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    await expect(resolveMailboxHost(input.host)).rejects.toThrow("public");
  });
  it("discovers Sent special use and validates override", () => {
    const folders = [
      { path: "INBOX" },
      { path: "Sent Items", specialUse: "\\Sent" },
    ];
    expect(discoverSentFolder(folders)).toBe("Sent Items");
    expect(() => discoverSentFolder(folders, "Missing")).toThrow();
  });
  it("parses plain text with stable fallback identity", async () => {
    const raw = Buffer.from(
      "From: Them <them@example.com>\r\nTo: me@example.com\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nWorld"
    );
    const a = await parseMailboxMessage(raw);
    const b = await parseMailboxMessage(raw);
    expect(a.from).toBe("them@example.com");
    expect(a.body.trim()).toBe("World");
    expect(a.messageId).toBe(b.messageId);
  });
});
