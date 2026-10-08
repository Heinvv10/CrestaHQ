import { expect, it, vi } from "vitest";
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: vi.fn() }));
vi.mock("@/lib/server/email-conversations", () => ({
  recordEmailMessage: vi.fn(),
}));
vi.mock("@/lib/prospecting/mystery-shop/inbound", () => ({
  matchMysteryShopEmail: vi.fn(async () => {}),
}));
import { cursorWindow } from "./mailbox-sync";
it("resets on UIDVALIDITY change and bounds every search", () => {
  expect(
    cursorWindow(
      { uidValidity: "old", uid: 9000, initialComplete: true },
      "new",
      10000
    )
  ).toEqual({ start: 1, end: 1000, reset: true });
  expect(
    cursorWindow(
      { uidValidity: "same", uid: 100, initialComplete: false },
      "same",
      150
    )
  ).toEqual({ start: 101, end: 149, reset: false });
});

vi.mock("@/lib/comms/imap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/imap")>()),
  connectMailbox: vi.fn(),
}));
import { getAdminDb } from "@/lib/firebase/admin";
import { connectMailbox } from "@/lib/comms/imap";
import { recordEmailMessage } from "@/lib/server/email-conversations";
import { syncMailbox, runMailboxSweep } from "./mailbox-sync";
function setup() {
  const c = {
    enabled: true,
    verifiedAt: new Date().toISOString(),
    version: "v1",
    leaseToken: null,
    leaseUntil: 0,
    cursors: {},
    sentFolder: null,
    ownAddresses: ["me@example.com"],
    initialSince: "2026-08-08T00:00:00Z",
  } as Record<string, unknown>;
  const updates: Record<string, unknown>[] = [];
  const tx = {
    get: vi.fn(async () => ({ data: () => structuredClone(c) })),
    update: vi.fn((_ref: unknown, v: Record<string, unknown>) => {
      updates.push(v);
      Object.assign(c, v);
    }),
  };
  vi.mocked(getAdminDb).mockReturnValue({
    doc: vi.fn((path: string) => path),
    runTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  } as never);
  const client = {
    mailbox: { uidValidity: BigInt(1), uidNext: 3 },
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    search: vi.fn(async () => [1, 2]),
    fetchOne: vi.fn(async (uid: number, q: { size?: boolean }) =>
      q.size
        ? { size: 100, internalDate: new Date("2026-09-01") }
        : {
            source: Buffer.from(
              `From: other@example.com\r\nTo: me@example.com\r\nMessage-ID: <${uid}@example.com>\r\n\r\nHello`
            ),
          }
    ),
    close: vi.fn(),
  };
  vi.mocked(connectMailbox).mockResolvedValue(client as never);
  vi.mocked(recordEmailMessage).mockResolvedValue({
    inserted: true,
    contactId: "contact",
  });
  return { c, updates, client };
}
it("imports BCC-only delivery using the connected mailbox recipient", async () => {
  const { client, c } = setup();
  client.fetchOne.mockImplementation(async (uid, q) =>
    q.size
      ? { size: 100, internalDate: new Date() }
      : {
          source: Buffer.from(
            `From: other@example.com\r\nTo: undisclosed-recipients:;\r\nMessage-ID: <${uid}@example.com>\r\n\r\nHello`
          ),
        }
  );
  vi.mocked(recordEmailMessage).mockImplementation(async (input) => {
    if (!input.to.length) throw new Error("missing delivery recipient");
    expect(input.to).toEqual(["me@example.com"]);
    return { inserted: true, contactId: "contact" };
  });
  expect((await syncMailbox("a")).imported).toBe(2);
  expect((c.cursors as Record<string, { uid: number }>).INBOX.uid).toBe(2);
});
it("gives both busy folders work and rotates the first folder", async () => {
  const { client, c } = setup();
  c.sentFolder = "INBOX.Sent";
  client.mailbox.uidNext = 27;
  let folder = "";
  client.getMailboxLock.mockImplementation(async (name?: unknown) => {
    folder = String(name);
    return { release: vi.fn() };
  });
  client.search.mockResolvedValue(Array.from({ length: 26 }, (_, i) => i + 1));
  client.fetchOne.mockImplementation(async (uid, q) =>
    q.size
      ? { size: 100, internalDate: new Date() }
      : {
          source: Buffer.from(
            `From: ${folder === "INBOX" ? "other" : "me"}@example.com\r\nTo: ${folder === "INBOX" ? "me" : "other"}@example.com\r\nMessage-ID: <${folder}-${uid}@example.com>\r\n\r\nHello`
          ),
        }
  );
  vi.mocked(recordEmailMessage).mockClear();
  const result = await syncMailbox("a");
  expect(result.hasMore).toBe(true);
  expect(
    vi
      .mocked(recordEmailMessage)
      .mock.calls.filter(([v]) => v.direction === "inbound")
  ).toHaveLength(10);
  expect(
    vi
      .mocked(recordEmailMessage)
      .mock.calls.filter(([v]) => v.direction === "outbound")
  ).toHaveLength(10);
  expect(c.nextFolder).toBe("INBOX.Sent");
});
it("imports with a lease fence and readOnly UID fetches", async () => {
  const { client, c } = setup();
  const result = await syncMailbox("tenant-a");
  expect(result.imported).toBe(2);
  expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX", {
    readOnly: true,
  });
  expect(recordEmailMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      subAccountId: "tenant-a",
      mailboxFence: { version: "v1", leaseToken: expect.any(String) },
      historical: true,
    })
  );
  expect(c.leaseToken).toBeNull();
  expect(c.cursors).toEqual({
    INBOX: { uidValidity: "1", uid: 2, initialComplete: true },
  });
});
it("does not advance past a failed durable ingestion; retry deduplicates", async () => {
  const { c } = setup();
  vi.mocked(recordEmailMessage)
    .mockResolvedValueOnce({ inserted: true, contactId: "a" })
    .mockRejectedValueOnce(new Error("secret provider details"));
  await expect(syncMailbox("a")).rejects.toThrow(
    "Mailbox connection or sync failed"
  );
  expect((c.cursors as Record<string, { uid: number }>).INBOX.uid).toBe(1);
  expect(c.lastError).not.toContain("secret");
  vi.mocked(recordEmailMessage).mockResolvedValue({
    inserted: false,
    contactId: "a",
  });
  const result = await syncMailbox("a");
  expect(result.skipped).toBe(1);
  expect(result.imported).toBe(0);
});
it("rejects concurrent workers before opening the network", async () => {
  const { c, client } = setup();
  c.leaseUntil = Date.now() + 10000;
  await expect(syncMailbox("a")).rejects.toThrow("already running");
  expect(client.getMailboxLock).not.toHaveBeenCalled();
});
it("imports an oversized message placeholder without source download", async () => {
  const { client, c } = setup();
  client.fetchOne.mockResolvedValue({
    size: 6 * 1024 * 1024,
    internalDate: new Date(),
    envelope: {
      from: [{ address: "other@example.com" }],
      to: [{ address: "me@example.com" }],
      messageId: "<large@example.com>",
    },
  } as never);
  const result = await syncMailbox("a");
  expect(result.imported).toBe(2);
  expect(result.skipped).toBe(2);
  expect(client.fetchOne).toHaveBeenCalledTimes(2);
  expect(recordEmailMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.stringContaining("5 MB"),
      messageId: "<large@example.com>",
    })
  );
  expect((c.cursors as Record<string, { uid: number }>).INBOX.uid).toBe(2);
});
it("sweep isolates failures and continues other tenants", async () => {
  setup();
  const db = getAdminDb();
  const chain = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    get: vi.fn(async () => ({ docs: [{ id: "a" }, { id: "b" }] })),
  };
  Object.assign(db, { collection: vi.fn(() => chain) });
  vi.mocked(connectMailbox).mockRejectedValueOnce(new Error("bad credentials"));
  const result = await runMailboxSweep();
  expect(result.results[0]).toEqual({ subAccountId: "a", failed: true });
  expect(result.results[1]).toEqual(
    expect.objectContaining({ subAccountId: "b", imported: 2 })
  );
});
it("stops a stale worker without overwriting a replacement connection", async () => {
  const { c, client } = setup();
  client.search.mockImplementation(async () => {
    c.version = "replacement";
    return [1];
  });
  await expect(syncMailbox("a")).rejects.toThrow("settings changed");
  expect(c.version).toBe("replacement");
});
it("does not archive Sent-folder staff notices", async () => {
  const { c, client } = setup();
  c.sentFolder = "INBOX.Sent";
  client.search.mockResolvedValueOnce([]).mockResolvedValueOnce([1]);
  client.fetchOne.mockImplementation(async (_uid, q) =>
    q.size
      ? { size: 100, internalDate: new Date() }
      : {
          source: Buffer.from(
            "From: me@example.com\r\nTo: staff@example.com\r\nX-CrestaHQ-Archive: no\r\n\r\nPrivate login link"
          ),
        }
  );
  vi.mocked(recordEmailMessage).mockClear();
  const result = await syncMailbox("a");
  expect(result.skipped).toBe(1);
  expect(recordEmailMessage).not.toHaveBeenCalled();
});
it("an inbound archive header cannot hide customer email", async () => {
  const { client } = setup();
  client.search.mockResolvedValue([1]);
  client.fetchOne.mockImplementation(async (_uid, q) =>
    q.size
      ? { size: 100, internalDate: new Date() }
      : {
          source: Buffer.from(
            "From: customer@example.com\r\nTo: me@example.com\r\nX-CrestaHQ-Archive: no\r\n\r\nCustomer mail"
          ),
        }
  );
  const result = await syncMailbox("a");
  expect(result.imported).toBe(1);
});

import { matchMysteryShopEmail } from "@/lib/prospecting/mystery-shop/inbound";
it("hands each inbound message to the mystery-shop matcher at its arrival time, with its auto-reply headers", async () => {
  const { client } = setup();
  client.search.mockResolvedValue([1]);
  const at = new Date("2026-10-08T10:00:00Z");
  client.fetchOne.mockImplementation(async (_uid, q) =>
    q.size
      ? { size: 100, internalDate: at }
      : {
          source: Buffer.from(
            "From: info@acme.co.za\r\nTo: me@example.com\r\nSubject: Re: Enquiry\r\nIn-Reply-To: <shop@crestahq.com>\r\nAuto-Submitted: auto-replied\r\nPrecedence: bulk\r\nMessage-ID: <r1@acme.co.za>\r\n\r\nThanks"
          ),
        }
  );
  vi.mocked(matchMysteryShopEmail).mockClear();
  await syncMailbox("tenant-a");
  expect(matchMysteryShopEmail).toHaveBeenCalledWith(
    "tenant-a",
    expect.objectContaining({
      from: "info@acme.co.za",
      subject: "Re: Enquiry",
      inReplyTo: "<shop@crestahq.com>",
      occurredAtMs: at.getTime(),
      autoReply: { autoSubmitted: "auto-replied", xAutoreply: null, xAutorespond: null, precedence: "bulk" },
    })
  );
});
it("a failing mystery-shop matcher never breaks the sync; sent mail is never matched", async () => {
  const { client, c } = setup();
  c.sentFolder = "Sent";
  client.search.mockResolvedValue([1]);
  let folder = "";
  client.getMailboxLock.mockImplementation(async (name?: unknown) => {
    folder = String(name);
    return { release: vi.fn() };
  });
  client.fetchOne.mockImplementation(async (_uid, q) =>
    q.size
      ? { size: 100, internalDate: new Date() }
      : {
          source: Buffer.from(
            folder === "Sent"
              ? "From: me@example.com\r\nTo: info@acme.co.za\r\nMessage-ID: <out@example.com>\r\n\r\nHi"
              : "From: info@acme.co.za\r\nTo: me@example.com\r\nMessage-ID: <in@example.com>\r\n\r\nHi"
          ),
        }
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(matchMysteryShopEmail).mockClear().mockRejectedValue(new Error("firestore down"));
  const result = await syncMailbox("a");
  expect(result.imported).toBe(2);
  expect(matchMysteryShopEmail).toHaveBeenCalledTimes(1);
  expect(vi.mocked(matchMysteryShopEmail).mock.calls[0][1].from).toBe("info@acme.co.za");
});
