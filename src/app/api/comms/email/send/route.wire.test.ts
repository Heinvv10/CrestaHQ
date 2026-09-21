import { beforeEach, expect, it, vi } from "vitest";

/**
 * The reply headers on the WIRE, not on a helper's return value. Only the
 * network edges are replaced: auth, Firestore, and nodemailer's SMTP socket
 * (swapped for its own stream transport, which renders the exact RFC 5322
 * bytes an SMTP server would receive). The route, `sendEmail` routing and
 * `sendSmtpEmail` all run for real.
 */
const m = vi.hoisted(() => ({
  raw: [] as string[],
  recorded: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: () => ({ uid: "user", email: "operator@example.com" }),
  requireContactAccessible: async () => ({
    subAccountId: "sa",
    email: "friend@example.com",
  }),
}));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
  recordUsage: async () => {},
}));
vi.mock("@/lib/comms/usage", () => ({ recordSend: async () => {} }));
vi.mock("@/lib/landing/resolve-brand", () => ({
  resolveCustomBrand: async () => ({}),
}));
vi.mock("@/lib/server/email-conversations", () => ({
  recordEmailMessage: async (input: Record<string, unknown>) => {
    m.recorded.push(input);
    return { contactId: "contact", inserted: true };
  },
}));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
}));
const DOCS: Record<string, unknown> = {
  "subAccounts/sa": {
    emailProvider: "smtp",
    smtpConfig: {
      host: "smtp.example.com",
      fromEmail: "desk@example.com",
      verifiedAt: "2026-09-08T00:00:00Z",
    },
  },
  "subAccounts/sa/private/smtpConnection": {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "desk@example.com",
    password: "secret",
    fromEmail: "desk@example.com",
    fromName: "Desk",
    verifiedAt: "2026-09-08T00:00:00Z",
  },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: path in DOCS, data: () => DOCS[path] }),
    }),
    collection: () => ({
      doc: () => ({ collection: () => ({ add: async () => {} }) }),
    }),
  }),
}));
vi.mock("nodemailer", async (importOriginal) => {
  const real = (await importOriginal<typeof import("nodemailer")>()).default;
  return {
    default: {
      createTransport: () => {
        const stream = real.createTransport({ streamTransport: true, buffer: true });
        return {
          sendMail: async (mail: { to: string }) => {
            const info = await stream.sendMail(mail);
            m.raw.push((info.message as Buffer).toString());
            // The server's acceptance — the one thing a stream transport has no concept of.
            return { ...info, accepted: [mail.to] };
          },
          close: () => {},
        };
      },
    },
  };
});
import { POST } from "./route";

/** Header block of the last emitted message, unfolded, keyed lower-case. */
function wireHeaders(): Record<string, string> {
  const head = m.raw.at(-1)!.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  return Object.fromEntries(
    head.split(/\r?\n/).map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
    })
  );
}
const post = (body: unknown) =>
  POST(new Request("https://example.com", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  m.raw.length = 0;
  m.recorded.length = 0;
});

it("puts In-Reply-To and References on the wire and records the sent Message-ID", async () => {
  const res = await post({
    contactId: "contact",
    subject: "Re: Hello",
    body: "Thanks, see you Tuesday.",
    inReplyTo: "<parent@mail.example.com>",
    references: ["<root@mail.example.com>", "<parent@mail.example.com>"],
  });
  expect(res.status).toBe(200);
  const headers = wireHeaders();
  expect(headers["in-reply-to"]).toBe("<parent@mail.example.com>");
  expect(headers["references"]).toBe("<root@mail.example.com> <parent@mail.example.com>");
  expect(headers["subject"]).toBe("Re: Hello");
  expect(headers["to"]).toBe("friend@example.com");
  // The persisted row carries the SAME Message-ID the recipient's client saw,
  // so their reply (and ours to it) can thread back to this row.
  const messageId = headers["message-id"];
  expect(messageId).toMatch(/^<[^\s<>]+@[^\s<>]+>$/);
  expect(m.recorded).toEqual([
    expect.objectContaining({
      direction: "outbound",
      contactId: "contact",
      messageId,
      inReplyTo: "<parent@mail.example.com>",
      references: ["<root@mail.example.com>", "<parent@mail.example.com>"],
      subject: "Re: Hello",
    }),
  ]);
  expect((await res.json()).id).toBe(messageId);
});

it("sends a new email with no thread headers at all", async () => {
  const res = await post({ contactId: "contact", subject: "Hello", body: "Hi" });
  expect(res.status).toBe(200);
  const headers = wireHeaders();
  expect(headers["subject"]).toBe("Hello");
  expect(headers).not.toHaveProperty("in-reply-to");
  expect(headers).not.toHaveProperty("references");
});
