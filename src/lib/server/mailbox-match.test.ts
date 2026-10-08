import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * matchOrSkip's failure bookkeeping, on the in-memory Firestore: the count is
 * saved in its own transaction that checks only the connection version (not
 * the sync lease), a matcher that hangs times out as a failure, a success
 * clears the record for that message, and the count is per message.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const match = vi.fn();
vi.mock("@/lib/prospecting/mystery-shop/inbound", () => ({ matchMysteryShopEmail: (...a: unknown[]) => match(...a) }));
const { mem } = await import("@/test/gbp-sync-store");
const { MATCH_TIMEOUT_MS, matchOrSkip } = await import("./mailbox-match");

const PATH = "subAccounts/sa1/private/mailboxConnection";
const AT = { folder: "INBOX", uidValidity: "7", uid: 42 };
const MESSAGE = { from: "x@y.z" } as never;
const connection = () => ({ ...(mem.read(PATH) as Record<string, unknown>) }) as never;
const live = () => mem.read(PATH)!;

beforeEach(() => {
  mem.clear();
  mem.seed(PATH, { version: "v1", leaseToken: "t1", leaseUntil: Date.now() + 90_000, matchFailure: null });
  match.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the failure count", () => {
  it("is saved even after the sync lost its lease (only the connection version is checked)", async () => {
    match.mockRejectedValue(new Error("slow then failed"));
    const conn = connection();
    mem.seed(PATH, { ...live(), leaseToken: "someone-else", leaseUntil: 0 });
    await expect(matchOrSkip("sa1", conn, AT, MESSAGE)).rejects.toThrow("Reply matching failed. Retry sync.");
    expect(live().matchFailure).toEqual({ ...AT, count: 1 });
  });

  it("is not saved onto a connection whose settings changed (another version)", async () => {
    match.mockRejectedValue(new Error("x"));
    const conn = connection();
    mem.seed(PATH, { ...live(), version: "v2" });
    await expect(matchOrSkip("sa1", conn, AT, MESSAGE)).rejects.toThrow();
    expect(live().matchFailure).toBeNull();
  });

  it("starts at 1 for the same folder and uid under another UIDVALIDITY", async () => {
    match.mockRejectedValue(new Error("x"));
    mem.seed(PATH, { ...live(), matchFailure: { ...AT, uidValidity: "6", count: 2 } });
    await expect(matchOrSkip("sa1", connection(), AT, MESSAGE)).rejects.toThrow();
    expect(live().matchFailure).toEqual({ ...AT, count: 1 });
  });

  it("the third failure in a row of the same message skips it: recorded, count cleared, no throw", async () => {
    match.mockRejectedValue(new Error("x"));
    mem.seed(PATH, { ...live(), matchFailure: { ...AT, count: 2 } });
    await matchOrSkip("sa1", connection(), AT, MESSAGE);
    expect(live().matchFailure).toBeNull();
    expect(live().matchSkipped).toMatchObject(AT);
  });
});

describe("a matcher that hangs", () => {
  it(`times out after ${MATCH_TIMEOUT_MS / 1000} s — well inside the 90 s lease — and counts as a failure`, async () => {
    expect(MATCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    match.mockReturnValue(new Promise(() => {}));
    const run = matchOrSkip("sa1", connection(), AT, MESSAGE);
    const outcome = expect(run).rejects.toThrow("Reply matching failed. Retry sync.");
    await vi.advanceTimersByTimeAsync(MATCH_TIMEOUT_MS);
    await outcome;
    expect(live().matchFailure).toEqual({ ...AT, count: 1 });
  });
});

describe("a successful match", () => {
  it("clears the failure record of that same message", async () => {
    mem.seed(PATH, { ...live(), matchFailure: { ...AT, count: 2 } });
    await matchOrSkip("sa1", connection(), AT, MESSAGE);
    expect(live().matchFailure).toBeNull();
  });

  it("leaves another message's failure record alone", async () => {
    const other = { ...AT, uid: 43, count: 2 };
    mem.seed(PATH, { ...live(), matchFailure: other });
    await matchOrSkip("sa1", connection(), AT, MESSAGE);
    expect(live().matchFailure).toEqual(other);
  });
});
