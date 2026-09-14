// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewsSection } from "./reviews-section";

/**
 * The explicit reply composer on each review, rendered for real (jsdom) —
 * only `fetch` is stubbed. One click posts once; the key made when the
 * composer opened is reused on a retry of the same text; success and failure
 * show inline; no confirm()/alert().
 */

const BASE = "/api/sub-accounts/sa1/gbp";
const REPLY = (docId: string) => `${BASE}/reviews/${docId}/reply`;
const TEXT = "  Sorry about that.\nWe'll call you today.  ";

const review = (id: string, reply: { comment: string; updateTime: string } | null = null) => ({
  reviewId: id, docId: `doc-${id}`,
  reviewer: { displayName: `Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
  starRating: 2, comment: `Comment ${id}`,
  createTime: "2026-08-20T09:00:00.000Z", updateTime: "2026-08-20T09:00:00.000Z", reply,
});

let container: HTMLDivElement;
let root: Root;
let posted: { comment: string; updateTime: string } | null;
let replyResult: () => Promise<{ status: number; body: unknown }>;
const fetchMock = vi.fn();
const replyPosts = () =>
  fetchMock.mock.calls
    .filter(([u, i]) => u === REPLY("doc-r1") && i?.method === "POST")
    .map(([, i]) => JSON.parse(String(i.body)) as { comment: string; idempotencyKey: string });

beforeEach(() => {
  posted = null;
  replyResult = async () => {
    posted = { comment: TEXT, updateTime: "2026-09-11T10:00:00Z" };
    return { status: 200, body: { reply: posted } };
  };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === `${BASE}/reviews`) {
      const body = { summary: null, reviews: [review("r2", { comment: "Thanks!", updateTime: "2026-08-21T09:00:00Z" }), review("r1", posted)], available: 2, runs: [] };
      return { ok: true, status: 200, json: async () => body };
    }
    if (method === "POST" && url === REPLY("doc-r1")) {
      const { status, body } = await replyResult();
      return { ok: status < 400, status, json: async () => body };
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("alert", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(window.alert).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function render(props: { canSync?: boolean; reconnect?: boolean } = {}) {
  await act(async () =>
    root.render(createElement(ReviewsSection, { subAccountId: "sa1", canSync: props.canSync ?? true, reconnect: props.reconnect ?? false })),
  );
}
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const click = (id: string) => act(async () => (byId(id) as HTMLButtonElement).click());
async function type(value: string) {
  const el = byId("gbp-reply-text") as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  await act(async () => void el.dispatchEvent(new Event("input", { bubbles: true })));
}

describe("who sees Reply", () => {
  it("an admin: Reply on an unreplied review, Edit reply on a replied one", async () => {
    await render();
    expect(byId("gbp-reply-open-r1")?.textContent).toBe("Reply");
    expect(byId("gbp-reply-open-r2")?.textContent).toBe("Edit reply");
  });

  it.each([
    ["a non-admin", { canSync: false }],
    ["anyone while the connection needs a reconnect", { reconnect: true }],
  ])("not %s", async (_l, props) => {
    await render(props);
    expect(container.querySelector('[data-testid^="gbp-reply-open-"]')).toBeNull();
  });
});

describe("composing", () => {
  it("says the reply will be public on Google, and will not post blank text", async () => {
    await render();
    await click("gbp-reply-open-r1");
    expect(byId("gbp-reply-composer")?.textContent).toContain("public on Google");
    expect((byId("gbp-reply-submit") as HTMLButtonElement).textContent).toBe("Post reply to Google");
    await type("   ");
    expect((byId("gbp-reply-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an edit starts from the current reply", async () => {
    await render();
    await click("gbp-reply-open-r2");
    expect((byId("gbp-reply-text") as HTMLTextAreaElement).value).toBe("Thanks!");
  });

  it("posts exactly what was typed, once, with a key; disabled while pending; then shows the reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = replyResult;
    replyResult = async () => (await gate, inner());
    await render();
    await click("gbp-reply-open-r1");
    await type(TEXT);
    await click("gbp-reply-submit");
    expect((byId("gbp-reply-submit") as HTMLButtonElement).disabled).toBe(true);
    await click("gbp-reply-submit");
    await act(async () => release());

    const posts = replyPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].comment).toBe(TEXT);
    expect(posts[0].idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(byId("gbp-reply-composer")).toBeNull();
    expect(byId("gbp-review-reply-r1")?.textContent).toContain("We'll call you today.");
  });
});

describe("failure", () => {
  it("shows the error inline, keeps the text, and a retry of the same text reuses the key", async () => {
    replyResult = async () => ({ status: 424, body: { code: "transient", error: "Google request failed" } });
    await render();
    await click("gbp-reply-open-r1");
    await type(TEXT);
    await click("gbp-reply-submit");
    expect(byId("gbp-reply-error")?.textContent).toContain("Google request failed");
    expect((byId("gbp-reply-text") as HTMLTextAreaElement).value).toBe(TEXT);

    await click("gbp-reply-submit");
    const [first, second] = replyPosts();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);

    await type("Different words.");
    await click("gbp-reply-submit");
    expect(replyPosts()[2].idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("a network failure is shown inline too", async () => {
    replyResult = async () => {
      throw new Error("offline");
    };
    await render();
    await click("gbp-reply-open-r1");
    await type(TEXT);
    await click("gbp-reply-submit");
    expect(byId("gbp-reply-error")?.textContent).toContain("could not be posted");
  });
});

describe("posted, not yet recorded", () => {
  it("says it is on Google and that the inbox catches up on the next sync", async () => {
    replyResult = async () => ({ status: 200, body: { reply: { comment: TEXT, updateTime: "2026-09-11T10:00:00Z" }, localRecordPending: true } });
    await render();
    await click("gbp-reply-open-r1");
    await type(TEXT);
    await click("gbp-reply-submit");
    expect(byId("gbp-reply-notice")?.textContent).toBe("Posted to Google — the inbox will catch up on the next sync.");
    expect(byId("gbp-reply-composer")).toBeNull();
    expect(byId("gbp-reply-error")).toBeNull();
  });
});
