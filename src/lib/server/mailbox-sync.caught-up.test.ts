import { beforeEach, expect, it, vi } from "vitest";

/**
 * `mailboxConfig.inboxCaughtUpAt`: the mystery-shop missed verdict waits for
 * it, so it is written only when a sync pass consumed the INBOX completely —
 * never on a partial pass (more mail left), a Sent-folder-only pass or an
 * error — and it is the pass's START (mail that arrived before it was seen).
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: vi.fn() }));
vi.mock("@/lib/server/email-conversations", () => ({ recordEmailMessage: vi.fn(async () => ({ inserted: true })) }));
vi.mock("@/lib/prospecting/mystery-shop/inbound", () => ({ matchMysteryShopEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/comms/imap", async (orig) => ({ ...(await orig<typeof import("@/lib/comms/imap")>()), connectMailbox: vi.fn() }));
const { getAdminDb } = await import("@/lib/firebase/admin");
const { connectMailbox } = await import("@/lib/comms/imap");
const { syncMailbox } = await import("./mailbox-sync");

let subUpdates: Record<string, unknown>[];
function setup(uids: number[], uidNext: number, opts: { sentFolder?: string; fail?: boolean; failIn?: string; onLock?: (f: string) => void; onFetch?: () => void } = {},
) {
  const c: Record<string, unknown> = {
    enabled: true, verifiedAt: new Date().toISOString(), version: "v1", leaseToken: null, leaseUntil: 0, cursors: {},
    sentFolder: opts.sentFolder ?? null, ownAddresses: ["me@example.com"], initialSince: "2026-08-08T00:00:00Z",
  };
  subUpdates = [];
  const tx = {
    get: vi.fn(async () => ({ data: () => structuredClone(c) })),
    update: vi.fn((ref: string, v: Record<string, unknown>) => (ref === "subAccounts/a" ? subUpdates.push(v) : Object.assign(c, v))),
  };
  vi.mocked(getAdminDb).mockReturnValue({ doc: (p: string) => p, runTransaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never);
  let folder = "";
  vi.mocked(connectMailbox).mockResolvedValue({
    mailbox: { uidValidity: BigInt(1), uidNext },
    getMailboxLock: vi.fn(async (name: string) => (opts.onLock?.(name), (folder = name), { release: vi.fn() })),
    search: vi.fn(async () => uids),
    fetchOne: vi.fn(async (uid: number, q: { size?: boolean }) => {
      opts.onFetch?.();
      if ((opts.fail || opts.failIn === folder) && !q.size) throw new Error("socket closed");
      return q.size
        ? { size: 100, internalDate: new Date() }
        : { source: Buffer.from(`From: o@example.com\r\nTo: me@example.com\r\nMessage-ID: <${uid}@x>\r\n\r\nHi`) };
    }),
    close: vi.fn(),
  } as never);
}
const caughtUp = () => subUpdates.map((u) => u["mailboxConfig.inboxCaughtUpAt"]).filter(Boolean);

beforeEach(() => vi.clearAllMocks());

it("is stamped with the pass's start when the INBOX was read to the end", async () => {
  setup([1, 2], 3);
  const before = Date.now();
  await syncMailbox("a");
  expect(caughtUp()).toHaveLength(1);
  const at = Date.parse(caughtUp()[0] as string);
  expect(at).toBeGreaterThanOrEqual(before - 1000);
  expect(at).toBeLessThanOrEqual(Date.now());
});

it("an empty INBOX (nothing new) is caught up too", async () => {
  setup([], 1);
  await syncMailbox("a");
  expect(caughtUp()).toHaveLength(1);
});

it("is NOT stamped while more INBOX mail is left (a partial pass)", async () => {
  setup(Array.from({ length: 25 }, (_, i) => i + 1), 26);
  const res = await syncMailbox("a");
  expect(res.hasMore).toBe(true);
  expect(caughtUp()).toEqual([]);
});

it("is NOT stamped when the pass fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  setup([1], 2, { fail: true });
  await expect(syncMailbox("a")).rejects.toThrow();
  expect(caughtUp()).toEqual([]);
});

it("is NOT stamped when the INBOX was read to the end but the pass then failed (Sent folder)", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  setup([1], 2, { sentFolder: "Sent", failIn: "Sent" });
  await expect(syncMailbox("a")).rejects.toThrow();
  expect(caughtUp()).toEqual([]);
});

it("is when the INBOX read began, not when a slower pass finished", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t0 = Date.parse("2026-10-09T07:59:50Z");
    vi.setSystemTime(t0);
    let lockAt = 0;
    // Each fetch takes 5 s: the pass ends ~20 s after it began (inside the lease and the 35 s budget).
    setup([1, 2], 3, { onLock: (f) => void (f === "INBOX" && (lockAt ||= Date.now())), onFetch: () => vi.setSystemTime(Date.now() + 5_000) });
    await syncMailbox("a");
    const stamped = Date.parse(caughtUp()[0] as string);
    expect(stamped).toBe(t0);
    expect(stamped).toBeLessThanOrEqual(lockAt);
    expect(Date.now()).toBeGreaterThanOrEqual(t0 + 20_000);
  } finally {
    vi.useRealTimers();
  }
});
