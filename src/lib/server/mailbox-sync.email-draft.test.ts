import { beforeEach, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * The Email AI drafts hook in the mailbox sync: a NEW, LIVE inbound email from
 * a person queues one draft for its contact — after the pass, never inside it.
 * Historical backfill, Sent-folder mail, already-imported mail, auto-replies,
 * bounces and list mail queue nothing; several emails from one contact in a
 * pass queue one draft, for the newest. Mail imported before a pass fails
 * still gets its draft.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: vi.fn() }));
vi.mock("@/lib/server/email-conversations", () => ({ recordEmailMessage: vi.fn() }));
vi.mock("@/lib/prospecting/mystery-shop/inbound", () => ({ matchMysteryShopEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/comms/imap", async (orig) => ({ ...(await orig<typeof import("@/lib/comms/imap")>()), connectMailbox: vi.fn() }));
vi.mock("@/lib/comms/ai/email-draft", async (orig) => ({
  ...(await orig<typeof import("@/lib/comms/ai/email-draft")>()),
  maybeDraftEmailReply: vi.fn(async () => {}),
}));
const { getAdminDb } = await import("@/lib/firebase/admin");
const { connectMailbox } = await import("@/lib/comms/imap");
const { recordEmailMessage } = await import("@/lib/server/email-conversations");
const { maybeDraftEmailReply } = await import("@/lib/comms/ai/email-draft");
const { syncMailbox } = await import("./mailbox-sync");

const VERIFIED = Date.parse("2026-10-01T00:00:00Z");
interface Mail { from: string; at: number; headers?: string; subject?: string; contactId?: string; inserted?: boolean }

function setup(inbox: Mail[], opts: { sent?: Mail[]; failSent?: boolean } = {}) {
  const c: Record<string, unknown> = {
    enabled: true, verifiedAt: new Date(VERIFIED).toISOString(), version: "v1", leaseToken: null, leaseUntil: 0, cursors: {},
    sentFolder: opts.sent ? "Sent" : null, ownAddresses: ["me@example.com"], initialSince: "2026-08-08T00:00:00Z",
  };
  const tx = {
    get: vi.fn(async () => ({ data: () => structuredClone(c) })),
    update: vi.fn((ref: string, v: Record<string, unknown>) => (ref === "subAccounts/a" ? undefined : Object.assign(c, v))),
  };
  vi.mocked(getAdminDb).mockReturnValue({ doc: (p: string) => p, runTransaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never);
  const folders: Record<string, Mail[]> = { INBOX: inbox, ...(opts.sent ? { Sent: opts.sent } : {}) };
  let folder = "INBOX";
  const byMessageId = new Map<string, Mail>();
  vi.mocked(connectMailbox).mockResolvedValue({
    get mailbox() {
      return { uidValidity: BigInt(1), uidNext: folders[folder].length + 1 };
    },
    getMailboxLock: vi.fn(async (name: string) => ((folder = name), { release: vi.fn() })),
    search: vi.fn(async () => folders[folder].map((_, i) => i + 1)),
    fetchOne: vi.fn(async (uid: number, q: { size?: boolean }) => {
      const m = folders[folder][uid - 1];
      if (q.size) return { size: 100, internalDate: new Date(m.at) };
      if (folder === "Sent" && opts.failSent) throw new Error("socket closed");
      const id = `<${folder}-${uid}@x>`;
      byMessageId.set(id, m);
      const to = folder === "Sent" ? "ann@example.com" : "me@example.com";
      return {
        source: Buffer.from(
          `From: ${m.from}\r\nTo: ${to}\r\nSubject: ${m.subject ?? "Hello"}\r\nMessage-ID: ${id}\r\n${m.headers ?? ""}\r\nHi there`,
        ),
      };
    }),
    close: vi.fn(),
  } as never);
  vi.mocked(recordEmailMessage).mockImplementation(async (input) => {
    const m = byMessageId.get(input.messageId)!;
    return { contactId: m.contactId ?? "c1", inserted: m.inserted ?? true };
  });
}

const queued = async () => {
  await flushAfterResponse();
  return vi.mocked(maybeDraftEmailReply).mock.calls.map(([d]) => d);
};
const live = (over: Partial<Mail> = {}): Mail => ({ from: "ann@example.com", at: VERIFIED + 3600_000, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("queues one draft for a new live inbound email, with the thread headers the reply needs", async () => {
  setup([live({ subject: "Quote" })]);
  await syncMailbox("a");
  expect(await queued()).toEqual([
    expect.objectContaining({
      subAccountId: "a", contactId: "c1", from: "ann@example.com", subject: "Quote",
      messageId: "<INBOX-1@x>", body: expect.stringContaining("Hi there"),
    }),
  ]);
});

it("queues nothing for historical backfill, Sent-folder mail, or mail already imported", async () => {
  setup([live({ at: VERIFIED - 3600_000 }), live({ inserted: false, contactId: "c2" })], {
    sent: [{ from: "me@example.com", at: VERIFIED + 3600_000, headers: "X-CrestaHQ-Archive: yes\r\n" }],
  });
  await syncMailbox("a");
  expect(await queued()).toEqual([]);
});

it.each([
  ["an auto-reply", "Auto-Submitted: auto-replied\r\n", "Hello"],
  ["list mail", "List-Unsubscribe: <mailto:u@list.example>\r\n", "Hello"],
  ["an out-of-office", "", "Out of office: back Monday"],
])("queues nothing for %s", async (_label, headers, subject) => {
  setup([live({ headers, subject })]);
  await syncMailbox("a");
  expect(await queued()).toEqual([]);
});

it("queues nothing for a spoofed sender the receiving host's checks failed", async () => {
  setup([live({ headers: "Authentication-Results: mx.biz.test; spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com\r\n" })]);
  await syncMailbox("a");
  expect(await queued()).toEqual([]);
});

it("still queues a draft when the checks are only soft (softfail / dmarc=none)", async () => {
  setup([live({ headers: "Authentication-Results: mx.biz.test; spf=softfail smtp.mailfrom=example.com; dmarc=none header.from=example.com\r\n" })]);
  await syncMailbox("a");
  expect(await queued()).toHaveLength(1);
});

it("queues nothing for a bounce", async () => {
  setup([live({ from: "mailer-daemon@example.com", subject: "Undeliverable: Quote" })]);
  await syncMailbox("a");
  expect(await queued()).toEqual([]);
});

it("several emails from one contact in a pass queue ONE draft, for the newest", async () => {
  setup([
    live({ at: VERIFIED + 3_000_000, subject: "second" }),
    live({ at: VERIFIED + 1_000_000, subject: "first" }),
    live({ from: "bob@example.com", contactId: "c2", subject: "bob" }),
  ]);
  await syncMailbox("a");
  const d = await queued();
  expect(d.map((x) => [x.contactId, x.subject])).toEqual([["c1", "second"], ["c2", "bob"]]);
});

it("mail imported before the pass failed still gets its draft", async () => {
  setup([live()], { sent: [{ from: "me@example.com", at: VERIFIED + 3600_000 }], failSent: true });
  await expect(syncMailbox("a")).rejects.toThrow();
  expect(await queued()).toHaveLength(1);
});
