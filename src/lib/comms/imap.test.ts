import { describe, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { lookup } from "node:dns/promises";
import {
  validateMailboxInput,
  resolveMailboxHost,
  parseMailboxMessage,
  discoverSentFolder,
  mailSignalsFromRaw,
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
describe("mail signals for the mystery-shop matcher", () => {
  it("returns every Authentication-Results, topmost first, unfolded and capped", async () => {
    const raw = Buffer.from(
      "Authentication-Results: mx.crestahq.com;\r\n\tdmarc=fail header.from=acme.co.za\r\n" +
        "Authentication-Results: forged; dmarc=pass\r\n" +
        `Authentication-Results: x; ${"a".repeat(3000)}\r\n` +
        "From: info@acme.co.za\r\nTo: me@example.com\r\n\r\nHi"
    );
    const { authResults } = (await parseMailboxMessage(raw)).signals;
    expect(authResults[0]).toBe("mx.crestahq.com; dmarc=fail header.from=acme.co.za");
    expect(authResults[1]).toBe("forged; dmarc=pass");
    expect(authResults[2]).toHaveLength(2000);
    expect((await parseMailboxMessage(Buffer.from("From: a@b.c\r\n\r\nx"))).signals.authResults).toEqual([]);
  });
  it("reads auto-reply and delivery-report headers from a raw header block (the oversized path)", () => {
    const block = Array.from({ length: 12 }, (_, i) => `Authentication-Results: mx${i}; spf=pass`).join("\r\n");
    const s = mailSignalsFromRaw(
      `Auto-Submitted: auto-replied\r\nX-Autoreply: yes\r\nPrecedence: bulk\r\nList-Id: <news.acme>\r\nList-Unsubscribe: <mailto:u@acme>\r\nContent-Type: multipart/report;\r\n report-type=delivery-status\r\nX-MS-Exchange-Message-Is-Ndr: \r\nX-Failed-Recipients: info@acme.co.za\r\n${block}\r\n`
    );
    expect(s.authResults).toHaveLength(10);
    expect(s.authResults[0]).toBe("mx0; spf=pass");
    expect(s.autoReply).toEqual({
      autoSubmitted: "auto-replied", xAutoreply: "yes", xAutorespond: null, precedence: "bulk", listId: "<news.acme>", listUnsubscribe: "<mailto:u@acme>",
    });
    expect(s.dsn).toEqual({
      contentType: "multipart/report; report-type=delivery-status", msExchangeNdr: "", failedRecipients: "info@acme.co.za", text: "", deliveryStatus: "",
    });
  });
  it("exposes a bounce's report and returned-headers text so it can be tied to our Message-ID", async () => {
    const raw = Buffer.from(
      'From: MAILER-DAEMON@mx.example\r\nTo: me@example.com\r\nSubject: Undelivered Mail Returned to Sender\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n\r\n' +
        "--b\r\nContent-Type: text/plain\r\n\r\nYour message could not be delivered.\r\n" +
        "--b\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; info@acme.co.za\r\nAction: failed\r\n" +
        "--b\r\nContent-Type: text/rfc822-headers\r\n\r\nMessage-ID: <shop-1@crestahq.com>\r\nSubject: Enquiry\r\n--b--\r\n"
    );
    const { dsn } = (await parseMailboxMessage(raw)).signals;
    expect(dsn.contentType).toMatch(/^multipart\/report/);
    expect(dsn.text).toContain("<shop-1@crestahq.com>");
    // Only the delivery-status MIME part, not the human-readable text.
    expect(dsn.deliveryStatus).toBe("Final-Recipient: rfc822; info@acme.co.za\r\nAction: failed");
  });
  it("a delivery-status part is read even base64-encoded; a plain message has none", async () => {
    const part = Buffer.from("Final-Recipient: rfc822; a@b.co\r\nAction: failed\r\n").toString("base64");
    const raw = Buffer.from(
      'From: x@y.z\r\nContent-Type: multipart/report; report-type="delivery-status";\r\n boundary="=_b"\r\n\r\n' +
        `--=_b\r\nContent-Type: text/plain\r\n\r\nx\r\n--=_b\r\nContent-Type: message/delivery-status\r\nContent-Transfer-Encoding: base64\r\n\r\n${part}\r\n--=_b--\r\n`
    );
    expect((await parseMailboxMessage(raw)).signals.dsn.deliveryStatus).toBe("Final-Recipient: rfc822; a@b.co\r\nAction: failed");
    const plain = Buffer.from("From: x@y.z\r\nContent-Type: text/plain\r\n\r\nAction: failed\r\n");
    expect((await parseMailboxMessage(plain)).signals.dsn.deliveryStatus).toBe("");
  });
});
