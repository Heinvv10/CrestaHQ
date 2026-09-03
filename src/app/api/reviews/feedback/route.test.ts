import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-handler tests for the PUBLIC review-feedback endpoint.
 *
 * These exist because both HIGH findings from blind review lived in this file
 * and neither was catchable by a unit test of the token or the limiter:
 *
 *   1. the token burn was not atomic with the write (concurrent replay), and
 *   2. a click-through ping wrote a row while leaving the token live, so one
 *      token could be replayed into unlimited rows.
 *
 * Firestore is faked rather than emulated — the assertions that matter are
 * about WHICH writes the handler issues and in what order, which a recording
 * fake captures precisely. The transaction's read-before-write ordering is
 * asserted directly.
 */

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret-not-a-real-key";

// ── Fake Firestore ────────────────────────────────────────────────────────
interface TxCall {
  op: "get" | "set" | "update";
  path: string;
  data?: Record<string, unknown>;
}

let contactDoc: Record<string, unknown> | null;
let txCalls: TxCall[];
let txThrows: Error | null;

/** Doc refs carry the non-transactional writes the handler makes after the
 *  txn commits (the taskId back-reference), so those are recorded too. */
const outsideTxWrites: TxCall[] = [];
let backRefThrows: Error | null = null;
const docRef = (path: string) => ({
  path,
  update: async (data: Record<string, unknown>) => {
    if (backRefThrows) throw backRefThrows;
    outsideTxWrites.push({ op: "update", path, data });
  },
});

const fakeDb = {
  doc: (path: string) => docRef(path),
  collection: (name: string) => ({ doc: () => docRef(`${name}/generated-id`) }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    if (txThrows) throw txThrows;
    const tx = {
      get: async (ref: { path: string }) => {
        txCalls.push({ op: "get", path: ref.path });
        return {
          exists: contactDoc !== null,
          data: () => contactDoc,
        };
      },
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        txCalls.push({ op: "set", path: ref.path, data });
      },
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        txCalls.push({ op: "update", path: ref.path, data });
      },
    };
    return fn(tx);
  },
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeDb }));

const createTaskServerSide = vi.fn();
vi.mock("@/lib/server/tasks-service", () => ({
  createTaskServerSide: (...args: unknown[]) => createTaskServerSide(...args),
}));

// Real token lib + real limiter — those are the things under test alongside
// the handler, and both are pure.
import { issueReviewToken } from "@/lib/reviews/feedback-token";
import { POST } from "./route";

const CONTACT = "contact123";
const AGENCY = "agency123";
const SUB = "sub123";

function post(body: unknown, token?: string, ip = "198.51.100.1") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["x-review-token"] = token;
  headers["x-forwarded-for"] = ip;
  return POST(
    new Request("http://localhost/api/reviews/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** Issue a token and prime the fake contact so it verifies. */
function armedToken(extra: Record<string, unknown> = {}) {
  const { token, hash } = issueReviewToken(CONTACT);
  contactDoc = {
    agencyId: AGENCY,
    subAccountId: SUB,
    name: "Jane Doe",
    createdByUid: "uid1",
    mode: "live",
    reviewTokenHash: hash,
    ...extra,
  };
  return token;
}

const feedbackWrites = () =>
  txCalls.filter((c) => c.op === "set" && c.path.startsWith("reviewFeedback/"));
const contactUpdates = () =>
  txCalls.filter((c) => c.op === "update" && c.path.startsWith("contacts/"));
const burned = () =>
  contactUpdates().some((c) => "reviewTokenHash" in (c.data ?? {}));

let ipCounter = 0;
/** A fresh IP per test so the shared in-memory limiter never bleeds across. */
const freshIp = () => `198.51.100.${(ipCounter++ % 200) + 20}`;

beforeEach(() => {
  contactDoc = null;
  txCalls = [];
  txThrows = null;
  backRefThrows = null;
  outsideTxWrites.length = 0;
  createTaskServerSide.mockReset();
  createTaskServerSide.mockResolvedValue({ id: "task1" });
});

// ── Auth / input guards ───────────────────────────────────────────────────
describe("guards", () => {
  it("400s when the token header is absent", async () => {
    const res = await post({ rating: 5 }, undefined, freshIp());
    expect(res.status).toBe(400);
    expect(txCalls).toHaveLength(0);
  });

  it("404s an unverifiable token without touching Firestore", async () => {
    const res = await post({ rating: 5 }, "bogus.bogus.bogus", freshIp());
    expect(res.status).toBe(404);
    expect(txCalls).toHaveLength(0);
  });

  it("404s when the contact's stored hash doesn't match (link re-issued)", async () => {
    const token = armedToken({ reviewTokenHash: "some-other-hash" });
    const res = await post({ rating: 5 }, token, freshIp());
    expect(res.status).toBe(404);
    expect(feedbackWrites()).toHaveLength(0);
  });

  it("404s when the contact no longer exists", async () => {
    const { token } = issueReviewToken(CONTACT);
    contactDoc = null;
    const res = await post({ rating: 5 }, token, freshIp());
    expect(res.status).toBe(404);
  });

  it("500s — and writes nothing — when the contact lacks tenancy", async () => {
    const token = armedToken({ agencyId: "", subAccountId: "" });
    const res = await post({ rating: 5 }, token, freshIp());
    expect(res.status).toBe(500);
    expect(feedbackWrites()).toHaveLength(0);
  });

  it.each([0, 6, 2.5, -1, "five"])("400s an invalid rating (%s)", async (bad) => {
    const token = armedToken();
    const res = await post({ rating: bad }, token, freshIp());
    expect(res.status).toBe(400);
    expect(feedbackWrites()).toHaveLength(0);
  });

  it("400s when there is nothing at all to record", async () => {
    const token = armedToken();
    const res = await post({}, token, freshIp());
    expect(res.status).toBe(400);
  });

  it("429s past the rate limit, before verifying the token", async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) await post({ rating: 5 }, armedToken(), ip);
    txCalls = [];
    const res = await post({ rating: 5 }, armedToken(), ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(txCalls).toHaveLength(0);
  });
});

// ── The HIGH: a click ping must not write a row or burn the token ─────────
describe("Google click-through ping", () => {
  it("writes NO feedback row and does NOT burn the token", async () => {
    const token = armedToken();
    const res = await post({ clickedGoogle: true }, token, freshIp());
    expect(res.status).toBe(200);
    expect(feedbackWrites()).toHaveLength(0);
    expect(burned()).toBe(false);
  });

  it("stamps reviewGoogleClickedAt on the contact instead", async () => {
    const token = armedToken();
    await post({ clickedGoogle: true }, token, freshIp());
    expect(contactUpdates()[0]!.data).toHaveProperty("reviewGoogleClickedAt");
  });

  it("stays replayable — N pings still write zero rows", async () => {
    const token = armedToken();
    for (let i = 0; i < 5; i++) {
      txCalls = [];
      const res = await post({ clickedGoogle: true }, token, freshIp());
      expect(res.status).toBe(200);
      expect(feedbackWrites()).toHaveLength(0);
    }
  });

  it("creates no follow-up task", async () => {
    const token = armedToken();
    await post({ clickedGoogle: true }, token, freshIp());
    expect(createTaskServerSide).not.toHaveBeenCalled();
  });
});

// ── Real submissions ──────────────────────────────────────────────────────
describe("submission", () => {
  it("writes exactly one row and burns the token", async () => {
    const token = armedToken();
    const res = await post(
      { rating: 4, comment: "Good service" },
      token,
      freshIp(),
    );
    expect(res.status).toBe(200);
    expect(feedbackWrites()).toHaveLength(1);
    expect(burned()).toBe(true);
  });

  it("stamps tenancy from the CONTACT, never from the request body", async () => {
    const token = armedToken();
    await post(
      { rating: 4, agencyId: "attacker", subAccountId: "attacker" },
      token,
      freshIp(),
    );
    const row = feedbackWrites()[0]!.data!;
    expect(row.agencyId).toBe(AGENCY);
    expect(row.subAccountId).toBe(SUB);
  });

  it("carries clickedGoogle forward from an earlier ping", async () => {
    const token = armedToken({ reviewGoogleClickedAt: new Date() });
    await post({ rating: 5 }, token, freshIp());
    expect(feedbackWrites()[0]!.data!.clickedGoogle).toBe(true);
  });

  it("truncates an over-long comment rather than rejecting it", async () => {
    const token = armedToken();
    await post({ rating: 3, comment: "x".repeat(5000) }, token, freshIp());
    expect((feedbackWrites()[0]!.data!.comment as string).length).toBe(2000);
  });

  it("stamps piiExpiresAt so the cleanup sweep can find the row", async () => {
    const token = armedToken();
    await post({ rating: 5 }, token, freshIp());
    const expires = feedbackWrites()[0]!.data!.piiExpiresAt as Date;
    expect(expires).toBeInstanceOf(Date);
    expect(expires.getTime()).toBeGreaterThan(Date.now());
  });
});

// ── Follow-up task ────────────────────────────────────────────────────────
describe("follow-up task", () => {
  it.each([1, 2, 3])("opens a task for a low rating (%s★)", async (rating) => {
    const token = armedToken();
    const res = await post({ rating }, token, freshIp());
    expect(await res.json()).toMatchObject({ taskCreated: true });
  });

  it.each([4, 5])("opens no task for a high rating (%s★)", async (rating) => {
    const token = armedToken();
    const res = await post({ rating }, token, freshIp());
    expect(createTaskServerSide).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ taskCreated: false });
  });

  it("opens a task for a bare comment with no rating", async () => {
    const token = armedToken();
    await post({ comment: "Something went wrong" }, token, freshIp());
    expect(createTaskServerSide).toHaveBeenCalledOnce();
  });

  it("still returns 200 when the task write fails — feedback is already durable", async () => {
    createTaskServerSide.mockRejectedValue(new Error("firestore down"));
    const token = armedToken();
    const res = await post({ rating: 1, comment: "bad" }, token, freshIp());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ taskCreated: false });
    expect(feedbackWrites()).toHaveLength(1);
  });

  it("still reports the task when only the taskId back-reference write fails", async () => {
    // Regression: the back-reference used to share the task's try/catch, so a
    // failed update nulled taskId — reporting "no task" for a task that WAS
    // created, leaving an orphan nobody goes looking for.
    backRefThrows = new Error("update failed");
    const token = armedToken();
    const res = await post({ rating: 1 }, token, freshIp());
    expect(res.status).toBe(200);
    expect(createTaskServerSide).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ taskCreated: true });
  });

  it("writes the taskId back onto the feedback row on the happy path", async () => {
    const token = armedToken();
    await post({ rating: 1 }, token, freshIp());
    expect(outsideTxWrites).toContainEqual(
      expect.objectContaining({ data: { taskId: "task1" } }),
    );
  });

  it("defaults an unknown contact.mode to live rather than passing it through", async () => {
    const token = armedToken({ mode: "something-else" });
    await post({ rating: 1 }, token, freshIp());
    expect(createTaskServerSide.mock.calls[0]![0]).toMatchObject({
      mode: "live",
    });
  });
});

// ── Transaction shape ─────────────────────────────────────────────────────
describe("transaction", () => {
  it("does every read before any write (Firestore rejects read-after-write)", async () => {
    const token = armedToken();
    await post({ rating: 2, comment: "x" }, token, freshIp());
    const firstWrite = txCalls.findIndex((c) => c.op !== "get");
    const lastRead = txCalls.map((c) => c.op).lastIndexOf("get");
    expect(lastRead).toBeLessThan(firstWrite);
  });

  it("commits the row write and the token burn in the SAME transaction", async () => {
    const token = armedToken();
    await post({ rating: 2 }, token, freshIp());
    // Both recorded, and nothing was written outside the txn callback.
    expect(feedbackWrites()).toHaveLength(1);
    expect(burned()).toBe(true);
  });

  it("writes nothing when the transaction itself throws", async () => {
    const token = armedToken();
    txThrows = new Error("contention");
    await expect(post({ rating: 2 }, token, freshIp())).rejects.toThrow(
      "contention",
    );
    expect(feedbackWrites()).toHaveLength(0);
  });
});
