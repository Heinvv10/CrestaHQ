import { describe, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { lookup } from "node:dns/promises";
import {
  validateMailboxInput,
  resolveMailboxHost,
  parseMailboxMessage,
  discoverSentFolder,
  authResultsFromRaw,
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
describe("Authentication-Results", () => {
  it("returns every occurrence, topmost first, unfolded and capped", async () => {
    const raw = Buffer.from(
      "Authentication-Results: mx.crestahq.com;\r\n\tdmarc=fail header.from=acme.co.za\r\n" +
        "Authentication-Results: forged; dmarc=pass\r\n" +
        `Authentication-Results: x; ${"a".repeat(3000)}\r\n` +
        "From: info@acme.co.za\r\nTo: me@example.com\r\n\r\nHi"
    );
    const mail = await parseMailboxMessage(raw);
    expect(mail.authResults[0]).toBe("mx.crestahq.com; dmarc=fail header.from=acme.co.za");
    expect(mail.authResults[1]).toBe("forged; dmarc=pass");
    expect(mail.authResults[2]).toHaveLength(2000);
    expect((await parseMailboxMessage(Buffer.from("From: a@b.c\r\n\r\nx"))).authResults).toEqual([]);
  });
  it("reads the raw header block of an oversized message too, at most 10", () => {
    const block = Array.from({ length: 12 }, (_, i) => `Authentication-Results: mx${i}; spf=pass`).join("\r\n");
    const got = authResultsFromRaw(`X-CrestaHQ-Archive: no\r\n${block}\r\n`);
    expect(got).toHaveLength(10);
    expect(got[0]).toBe("mx0; spf=pass");
  });
});
