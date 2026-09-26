// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewsSection } from "./reviews-section";

/**
 * The Reviews tab's review auto-reply UI (AUTO_REPLY_V1_PLAN.md, PR 3): the
 * "Needs approval" filter and count, each row's reason, the composer
 * pre-filled with the stored draft (posted through the EXISTING reply route),
 * Discard, and the "Auto-replied" tag. Rendered for real (jsdom); only
 * `fetch` is stubbed, with the route's payload shape.
 */

const BASE = "/api/sub-accounts/sa1/gbp/reviews";
const DRAFT = "Thank you for your 3-star review of Velo Test Fibre.";
const DISMISS_409 = "This review has a reply or no auto-reply draft to discard.";

const review = (id: string, over: Record<string, unknown> = {}) => ({
  reviewId: id, docId: `doc-${id}`,
  reviewer: { displayName: `Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
  starRating: 3, comment: null, createTime: "2026-08-20T09:00:00.000Z", updateTime: "2026-08-20T09:00:00.000Z",
  reply: null, sentiment: null, autoReplied: false, approval: null,
  ...over,
});

let payload: Record<string, unknown>;
let dismissStatus: number;
const fetchMock = vi.fn();
const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  payload = {
    summary: null, runs: [], scheduled: false, truncated: false, aiDrafts: true, available: 3, needsApproval: 2,
    reviews: [
      review("held", { approval: { state: "held", draft: DRAFT } }),
      review("failed", { starRating: 1, approval: { state: "draft_failed", draft: null } }),
      review("auto", { starRating: 5, reply: { comment: "Thanks!", updateTime: "2026-08-21T09:00:00Z" }, autoReplied: true }),
    ],
  };
  dismissStatus = 200;
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith(BASE)) return json(payload);
    if (method === "POST" && url === `${BASE}/doc-held/reply`) return json({ ok: true, reply: { comment: DRAFT } });
    if (method === "POST" && url.endsWith("/auto-reply/dismiss")) {
      if (dismissStatus === 409) return json({ code: "nothing_to_dismiss", error: DISMISS_409 }, 409);
      return dismissStatus < 400 ? json({ ok: true }) : json({ code: "not_found", error: "Review not found." }, dismissStatus);
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
async function render(canSync = true) {
  await act(async () => root.render(createElement(ReviewsSection, { subAccountId: "sa1", canSync, reconnect: false })));
  await flush();
}
const byId = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => byId(id)!.click());
  await flush();
};
const calls = (method: string) => fetchMock.mock.calls.filter(([, i]) => ((i as RequestInit | undefined)?.method ?? "GET") === method);
const lastGet = () => calls("GET").at(-1)![0] as string;

describe("the Needs approval filter", () => {
  it("shows the count and asks the server for approval=needed when pressed, and back", async () => {
    await render();
    expect(byId("gbp-filter-needs-approval-count")?.textContent).toBe("(2)");
    expect(byId("gbp-filter-needs-approval")?.getAttribute("aria-pressed")).toBe("false");
    await click("gbp-filter-needs-approval");
    expect(lastGet()).toBe(`${BASE}?approval=needed`);
    expect(byId("gbp-filter-needs-approval")?.getAttribute("aria-pressed")).toBe("true");
    await click("gbp-filter-needs-approval");
    expect(lastGet()).toBe(BASE);
  });

  it("is not offered while nothing needs approval", async () => {
    payload = { ...payload, needsApproval: 0 };
    await render();
    expect(byId("gbp-filter-needs-approval")).toBeNull();
  });

  it("stays while it is the active filter, even once the count reaches 0", async () => {
    await render();
    await click("gbp-filter-needs-approval");
    payload = { ...payload, needsApproval: 0 };
    await click("gbp-filter-rating-5"); // any refetch
    expect(byId("gbp-filter-needs-approval-count")?.textContent).toBe("(0)");
  });
});

describe("rows", () => {
  it.each([
    ["held", "Held for approval"],
    ["queued", "Queued to auto-post"],
    ["paused", "Auto-post paused"],
    ["draft_failed", "Draft failed"],
    ["over_limit", "Over today's limit"],
    ["post_failed", "Post failed"],
  ])("state %s reads %s", async (state, label) => {
    payload = { ...payload, reviews: [review("x", { approval: { state, draft: null } })] };
    await render();
    expect(byId("gbp-review-approval-x")?.textContent).toBe(label);
  });

  it("an auto-posted reply carries the Auto-replied tag; others do not", async () => {
    payload = {
      ...payload,
      reviews: [...(payload.reviews as object[]), review("human", { reply: { comment: "Hi", updateTime: "2026-08-21T09:00:00Z" } })],
    };
    await render();
    expect(byId("gbp-review-auto-replied-auto")?.textContent?.trim()).toBe("Auto-replied");
    expect(byId("gbp-review-auto-replied-human")).toBeNull();
    expect(byId("gbp-review-approval-auto")).toBeNull();
  });
});

describe("the composer", () => {
  it("opens pre-filled with the stored draft, and Post sends exactly it through the existing reply route", async () => {
    await render();
    await click("gbp-reply-open-held");
    expect(byId<HTMLTextAreaElement>("gbp-reply-text")!.value).toBe(DRAFT);
    expect(byId("gbp-reply-draft-note")).not.toBeNull();
    await click("gbp-reply-submit");
    const posts = calls("POST");
    expect(posts.map(([u]) => u)).toEqual([`${BASE}/doc-held/reply`]);
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toMatchObject({ comment: DRAFT });
  });

  it("a row without draft text opens empty", async () => {
    await render();
    await click("gbp-reply-open-failed");
    expect(byId<HTMLTextAreaElement>("gbp-reply-text")!.value).toBe("");
    expect(byId("gbp-reply-draft-note")).toBeNull();
  });
});

describe("Discard", () => {
  it("dismisses through its route, then the list reloads: the row and one of the count are gone", async () => {
    await render();
    await click("gbp-filter-needs-approval");
    payload = { ...payload, needsApproval: 1, reviews: [(payload.reviews as object[])[1]] };
    await click("gbp-reply-discard-held");
    expect(calls("POST").map(([u]) => u)).toEqual([`${BASE}/doc-held/auto-reply/dismiss`]);
    expect(lastGet()).toBe(`${BASE}?approval=needed`);
    expect(byId("gbp-review-held")).toBeNull();
    expect(byId("gbp-filter-needs-approval-count")?.textContent).toBe("(1)");
  });

  it("a refusal shows inline and the row stays", async () => {
    dismissStatus = 404;
    await render();
    const gets = calls("GET").length;
    await click("gbp-reply-discard-held");
    expect(byId("gbp-reply-discard-error")?.textContent).toBe("Review not found.");
    expect(calls("GET")).toHaveLength(gets);
    expect(byId("gbp-review-held")).not.toBeNull();
  });

  it("a 409 (the row changed meanwhile, e.g. auto-posted) shows why and reloads the list as it is now", async () => {
    dismissStatus = 409;
    await render();
    const gets = calls("GET").length;
    const autoPosted = review("held", { reply: { comment: "Thanks!", updateTime: "2026-08-21T09:00:00Z" }, autoReplied: true });
    payload = { ...payload, needsApproval: 1, reviews: [autoPosted, (payload.reviews as object[])[1]] };
    await click("gbp-reply-discard-held");
    expect(byId("gbp-reply-discard-error")?.textContent).toBe(DISMISS_409);
    expect(calls("GET")).toHaveLength(gets + 1);
    expect(byId("gbp-review-auto-replied-held")).not.toBeNull();
    expect(byId("gbp-reply-discard-held")).toBeNull();
    expect(byId("gbp-filter-needs-approval-count")?.textContent).toBe("(1)");
  });

  it("is offered only on rows waiting for a person, and only to admins", async () => {
    await render();
    expect(byId("gbp-reply-discard-held")).not.toBeNull();
    expect(byId("gbp-reply-discard-failed")).not.toBeNull();
    expect(byId("gbp-reply-discard-auto")).toBeNull();
    await render(false);
    expect(byId("gbp-reply-discard-held")).toBeNull();
  });
});
