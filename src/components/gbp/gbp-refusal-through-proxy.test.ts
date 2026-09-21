// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A GBP provider refusal as the browser REALLY receives it: the real route
 * handler (real tenancy, fence, tokens, fake provider on the in-memory
 * store) → its actual Response → the deployment's edge → the real component's
 * parse. No hand-written body.
 *
 * The edge: crm.crestahq.com is served through Cloudflare, which "returns a
 * Cloudflare-branded HTTP 502 or 504 error when your origin web server
 * responds with a standard HTTP 502 bad gateway or 504 gateway timeout error"
 * (developers.cloudflare.com › Error 502 or 504). That HTML replaced the
 * route's `{error, code}` JSON, which is why #1000's picker read
 * "Couldn't load listings from Google (error)" while the server had logged
 * kind=rate_limited status=429.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const ctx = vi.hoisted(() => ({ subAccountId: "sa_1", isAdmin: true, loading: false, subAccount: {} as Record<string, unknown> }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));

import { SA, asUser, mem, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { GET as LOCATIONS } from "@/app/api/sub-accounts/[id]/google/locations/route";
import { GET as INSIGHTS } from "@/app/api/sub-accounts/[id]/reputation/insights/route";
import { resetInsightsMemo } from "@/lib/gbp/insights";
import { ACCESS_NOT_APPROVED_TEXT } from "@/lib/gbp/error-text";
import { gbpErrorResponse } from "@/lib/gbp/route-support";
import { GbpProviderError, type GbpProviderErrorKind } from "@/lib/gbp/provider/types";
import { ReputationInsights } from "@/components/reputation/insights";
import { ListingPicker } from "./listing-picker";

/** What Cloudflare does to an origin response (documented above). */
function viaCloudflare(res: Response): Response {
  if (res.status !== 502 && res.status !== 504) return res;
  return new Response("<!DOCTYPE html><title>Bad gateway | crm.crestahq.com | Cloudflare</title>", {
    status: res.status,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
}

/** Route each browser fetch to the REAL handler, through the edge. */
function browserFetch(uid: string) {
  return vi.fn(async (raw: string) => {
    const url = new URL(raw, "http://127.0.0.1:3100");
    const params = { params: Promise.resolve({ id: SA }) };
    const req = asUser(url.toString(), uid);
    if (url.pathname === `/api/sub-accounts/${SA}/google/locations`) return viaCloudflare(await LOCATIONS(req, params));
    if (url.pathname === `/api/sub-accounts/${SA}/reputation/insights`) return viaCloudflare(await INSIGHTS(req, params));
    throw new Error(`unexpected fetch ${raw}`);
  });
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetSync();
  resetInsightsMemo();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", browserFetch("uid_admin"));
  ctx.subAccount = mem.read(`subAccounts/${SA}`) as Record<string, unknown>;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The real handlers do real (in-memory) Firestore work: let time pass in
 * short act() slices until the element renders (React flushes state at the
 * end of each act, so one long act would never show it).
 */
async function shown(testId: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    const el = container.querySelector(`[data-testid="${testId}"]`);
    if (el) return el.textContent ?? "";
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`${testId} never rendered: ${container.textContent}`);
}

describe("Google's quota-0 refusal reaches the page as the sentence, not as the edge's error page", () => {
  it("the listing picker (GET …/google/locations)", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "listAccounts", kind: "access_not_approved" }));
    await act(async () => root.render(createElement(ListingPicker, { subAccountId: SA })));
    expect(await shown("gbp-picker-error")).toContain(ACCESS_NOT_APPROVED_TEXT);
  });

  it("the listing picker names any other provider kind too (here rate_limited), never '(error)'", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "listAccounts", kind: "rate_limited" }));
    await act(async () => root.render(createElement(ListingPicker, { subAccountId: SA })));
    const text = await shown("gbp-picker-error");
    expect(text).toContain("Google is rate-limiting requests.");
    expect(text).not.toContain("(error)");
  });

  it("the Insights tab (GET …/reputation/insights)", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "fetchDailyMetrics", kind: "access_not_approved" }));
    await act(async () => root.render(createElement(ReputationInsights)));
    // Waits for the Insights tab's own state — the generic rep-insights-error would never match.
    expect(await shown("rep-insights-not-approved")).toBe(ACCESS_NOT_APPROVED_TEXT);
  });
});

describe("gbpErrorResponse never answers a status the edge rewrites", () => {
  const KINDS: GbpProviderErrorKind[] = ["auth_expired", "permission_denied", "not_found", "rate_limited", "access_not_approved", "transient", "malformed"];
  it.each(KINDS)("%s → a JSON body with its code, on a status Cloudflare passes through", async (kind) => {
    const res = await gbpErrorResponse(new GbpProviderError(kind), SA, "test");
    expect([502, 504]).not.toContain(res.status);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await viaCloudflare(res).json()).code).toBe(kind);
  });
});
