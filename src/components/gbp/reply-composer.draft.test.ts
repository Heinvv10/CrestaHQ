// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewsSection } from "./reviews-section";

/**
 * "Draft with AI" in the reply composer (SP5 c), rendered for real (jsdom)
 * through the reviews section — only `fetch` is stubbed. A draft only fills
 * the box: nothing is posted until the admin clicks "Post reply to Google",
 * and then exactly the text in the box (edited or not) is posted once.
 */

const BASE = "/api/sub-accounts/sa1/gbp";
const REPLY = `${BASE}/reviews/doc-r1/reply`;
const DRAFT = `${BASE}/reviews/doc-r1/draft`;
const AI_TEXT = "Hi Reviewer, thank you for your 2-star review.\nThe Fixture Team";

const review = (id: string, reply: { comment: string; updateTime: string } | null = null) => ({
  reviewId: id, docId: `doc-${id}`,
  reviewer: { displayName: `Reviewer ${id}`, profilePhotoUrl: null, isAnonymous: false },
  starRating: 2, comment: `Comment ${id}`,
  createTime: "2026-08-20T09:00:00.000Z", updateTime: "2026-08-20T09:00:00.000Z", reply,
});

let container: HTMLDivElement;
let root: Root;
let aiDrafts: boolean | undefined;
let draftResult: () => Promise<{ status: number; body: unknown }>;
let replyStatus: number;
const fetchMock = vi.fn();
const posts = (url: string) =>
  fetchMock.mock.calls.filter(([u, i]) => u === url && i?.method === "POST").map(([, i]) => (i.body ? JSON.parse(String(i.body)) : null));

beforeEach(() => {
  aiDrafts = true;
  replyStatus = 200;
  draftResult = async () => ({ status: 200, body: { draft: AI_TEXT } });
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === `${BASE}/reviews`) {
      const body = { summary: null, reviews: [review("r2", { comment: "Thanks!", updateTime: "2026-08-21T09:00:00Z" }), review("r1")], available: 2, runs: [], aiDrafts };
      return { ok: true, status: 200, json: async () => body };
    }
    if (method === "POST" && url === DRAFT) {
      const { status, body } = await draftResult();
      return { ok: status < 400, status, json: async () => body };
    }
    if (method === "POST" && url === REPLY) {
      const sent = JSON.parse(String(init?.body)) as { comment: string };
      return { ok: replyStatus < 400, status: replyStatus, json: async () => (replyStatus < 400 ? { reply: { comment: sent.comment, updateTime: "2026-09-14T10:00:00Z" } } : { error: "Google request failed" }) };
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

async function render() {
  await act(async () => root.render(createElement(ReviewsSection, { subAccountId: "sa1", canSync: true, reconnect: false })));
}
const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(async () => byId(id)!.click());
const box = () => byId("gbp-reply-text") as HTMLTextAreaElement;
async function type(value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
  await act(async () => void box().dispatchEvent(new Event("input", { bubbles: true })));
}

describe("offered only when it can work", () => {
  it.each([[false], [undefined]])("no Draft button when aiDrafts is %s", async (flag) => {
    aiDrafts = flag;
    await render();
    await click("gbp-reply-open-r1");
    expect(byId("gbp-reply-draft")).toBeNull();
  });
});

describe("a draft only fills the box", () => {
  it("fills an empty box, says it is a draft, and posts NOTHING", async () => {
    await render();
    await click("gbp-reply-open-r1");
    await click("gbp-reply-draft");
    expect(posts(DRAFT)).toHaveLength(1);
    expect(box().value).toBe(AI_TEXT);
    expect(byId("gbp-reply-draft-note")?.textContent).toBe(
      "AI draft — check it, especially any phone numbers, emails or links, before posting. Nothing is sent until you click Post reply to Google.",
    );
    // Let any timers or effects run: still nothing posted, the composer still open.
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(posts(REPLY)).toHaveLength(0);
    expect(byId("gbp-reply-composer")).not.toBeNull();
  });

  it("the click posts exactly the EDITED text, once", async () => {
    await render();
    await click("gbp-reply-open-r1");
    await click("gbp-reply-draft");
    await type(`${AI_TEXT}\nEdited by a human.`);
    await click("gbp-reply-submit");
    const sent = posts(REPLY);
    expect(sent).toHaveLength(1);
    expect(sent[0].comment).toBe(`${AI_TEXT}\nEdited by a human.`);
  });

  it("text already in the box is replaced only after an inline confirm — never confirm()", async () => {
    await render();
    await click("gbp-reply-open-r1");
    await type("My own words.");
    await click("gbp-reply-draft");
    expect(posts(DRAFT)).toHaveLength(0);
    expect(byId("gbp-reply-draft-confirm")?.textContent).toContain("Replace your text?");
    await click("gbp-reply-draft-keep");
    expect(box().value).toBe("My own words.");
    expect(posts(DRAFT)).toHaveLength(0);
    await click("gbp-reply-draft");
    await click("gbp-reply-draft-replace");
    expect(posts(DRAFT)).toHaveLength(1);
    expect(box().value).toBe(AI_TEXT);
  });

  it("an existing reply counts as text: Edit reply → Draft asks first", async () => {
    await render();
    await click("gbp-reply-open-r2");
    await click("gbp-reply-draft");
    expect(byId("gbp-reply-draft-confirm")).not.toBeNull();
    expect(posts(DRAFT)).toHaveLength(0);
  });

  it("keeps the idempotency rule: a failed post, then a new draft, then a post uses a NEW key", async () => {
    replyStatus = 500;
    await render();
    await click("gbp-reply-open-r1");
    await click("gbp-reply-draft");
    await click("gbp-reply-submit");
    draftResult = async () => ({ status: 200, body: { draft: "A different draft." } });
    await click("gbp-reply-draft");
    await click("gbp-reply-draft-replace");
    replyStatus = 200;
    await click("gbp-reply-submit");
    const sent = posts(REPLY);
    expect(sent.map((s) => s.comment)).toEqual([AI_TEXT, "A different draft."]);
    expect(sent[1].idempotencyKey).not.toBe(sent[0].idempotencyKey);
  });
});

describe("races", () => {
  function holdDraft() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = draftResult;
    draftResult = async () => (await gate, inner());
    return () => act(async () => release());
  }

  it("Post is disabled while a draft is in flight", async () => {
    const release = holdDraft();
    await render();
    await click("gbp-reply-open-r1");
    await type("My words.");
    await click("gbp-reply-draft");
    await click("gbp-reply-draft-replace");
    expect((byId("gbp-reply-submit") as HTMLButtonElement).disabled).toBe(true);
    await release();
    expect((byId("gbp-reply-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("text typed while the draft was on its way is kept — the late draft is not applied", async () => {
    const release = holdDraft();
    await render();
    await click("gbp-reply-open-r1");
    await click("gbp-reply-draft");
    await type("I started writing my own.");
    await release();
    expect(box().value).toBe("I started writing my own.");
    expect(byId("gbp-reply-draft-note")).toBeNull();
    expect(byId("gbp-reply-draft-dropped")?.textContent).toBe("You edited the reply while the draft was on its way, so it wasn't applied.");
  });

  it("closing mid-draft leaves the reopened composer usable — not stuck drafting", async () => {
    const release = holdDraft();
    await render();
    await click("gbp-reply-open-r1");
    await click("gbp-reply-draft");
    expect((byId("gbp-reply-draft") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click());
    await click("gbp-reply-open-r1");
    expect((byId("gbp-reply-draft") as HTMLButtonElement).disabled).toBe(false);
    await type("Written by hand.");
    expect((byId("gbp-reply-submit") as HTMLButtonElement).disabled).toBe(false);
    await release();
    expect(box().value).toBe("Written by hand.");
  });

  it("a draft that arrives after the composer was closed and reopened is dropped silently", async () => {
    const release = holdDraft();
    await render();
    await click("gbp-reply-open-r1");
    await click("gbp-reply-draft");
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click());
    await click("gbp-reply-open-r1");
    await release();
    expect(box().value).toBe("");
    expect(byId("gbp-reply-draft-note")).toBeNull();
    expect(byId("gbp-reply-draft-dropped")).toBeNull();
    expect(posts(REPLY)).toHaveLength(0);
  });
});

describe("errors", () => {
  it("shows the route's message inline and leaves the box alone", async () => {
    draftResult = async () => ({ status: 429, body: { code: "daily_cap", error: "Daily AI limit reached — try again tomorrow." } });
    await render();
    await click("gbp-reply-open-r1");
    await click("gbp-reply-draft");
    expect(byId("gbp-reply-draft-error")?.textContent).toBe("Daily AI limit reached — try again tomorrow.");
    expect(box().value).toBe("");
    expect(byId("gbp-reply-draft-note")).toBeNull();
  });

  it("a network failure or an unreadable body shows a generic line", async () => {
    draftResult = async () => ({ status: 502, body: null });
    await render();
    await click("gbp-reply-open-r1");
    await click("gbp-reply-draft");
    expect(byId("gbp-reply-draft-error")?.textContent).toBe("Couldn't draft a reply. Try again, or write your own.");
  });
});
