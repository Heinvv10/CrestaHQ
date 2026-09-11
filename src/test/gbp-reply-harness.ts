import { createHash } from "node:crypto";
import { fakeScenarioPath, type FakeScenario } from "@/lib/gbp/provider/fake-scenario";
import { mem, SA, ACCOUNT, LOC_A } from "@/test/gbp-sync-harness";

/**
 * Helpers for the explicit-reply route tests, on top of gbp-sync-harness (the
 * in-memory Firestore, real tenancy, PR 1's real fake provider behind the
 * real fence). The fake logs every reply call in its scenario doc, which is
 * how these tests count calls "to Google".
 */

export const KEY = "compose-session-key-0001";

export const reviewName = (reviewId: string) => `${ACCOUNT}/${LOC_A}/reviews/${reviewId}`;

/** The cache doc id, computed here from the spec (sha256(review.name)[:40]) rather than borrowed from the code under test. */
export const docIdOf = (reviewId: string) =>
  createHash("sha256").update(reviewName(reviewId)).digest("hex").slice(0, 40);

export const reviewPath = (reviewId: string, sa = SA) => `subAccounts/${sa}/gbpReviews/${docIdOf(reviewId)}`;

/** The attempt doc for a key: sha256(idempotencyKey)[:40]. */
export const attemptPath = (key = KEY, sa = SA) =>
  `subAccounts/${sa}/gbpReplyAttempts/${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Reply calls that reached the fake for `sa`, in order. */
export const calls = (sa = SA) => ((mem.read(fakeScenarioPath(sa)) as FakeScenario | undefined)?.calls ?? []);

export const attempts = (sa = SA) => mem.list(`subAccounts/${sa}/gbpReplyAttempts`);
export const events = (sa = SA, type?: string) =>
  mem.list(`subAccounts/${sa}/gbpEvents`).filter((e) => !type || e.type === type);

type Handler = (req: Request, ctx: { params: Promise<{ id: string; reviewDocId: string }> }) => Promise<Response>;

/** Call the reply route as `uid` on `sa`'s review `docId`. A string body is sent raw. */
export async function callReply(
  handler: Handler,
  method: "POST" | "DELETE",
  uid: string,
  sa: string,
  docId: string,
  body?: unknown,
) {
  const url = `http://127.0.0.1:3100/api/sub-accounts/${sa}/gbp/reviews/${docId}/reply`;
  const init: RequestInit = { method, headers: { "x-user-uid": uid, "content-type": "application/json" } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await handler(new Request(url, init), { params: Promise.resolve({ id: sa, reviewDocId: docId }) });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & { code?: string; reply?: { comment: string; updateTime: string } } };
}
