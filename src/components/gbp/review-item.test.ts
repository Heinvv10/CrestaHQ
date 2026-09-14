// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewItem, type ReviewView } from "./review-item";

/** The per-review sentiment badge (SP5 b) — shown only when the review has a label. */

let container: HTMLUListElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("ul");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const review = (over: Partial<ReviewView> = {}): ReviewView => ({
  reviewId: "r1", docId: "d1", reviewer: { displayName: "Reviewer One", profilePhotoUrl: null, isAnonymous: false },
  starRating: 4, comment: "Fine.", createTime: "2026-08-20T09:00:00.000Z", updateTime: "2026-08-20T09:00:00.000Z",
  reply: null, sentiment: null, ...over,
});
const render = (r: ReviewView) => act(async () => root.render(createElement(ReviewItem, { review: r })));
const badge = () => container.querySelector('[data-testid="gbp-review-sentiment-r1"]');

describe("sentiment badge", () => {
  it.each([
    ["positive", "ai", "Positive", "AI-classified"],
    ["neutral", "ai", "Neutral", "AI-classified"],
    ["negative", "rating", "Negative", "From the star rating"],
  ])("%s by %s", async (label, method, text, title) => {
    await render(review({ sentiment: { label, method } }));
    expect(badge()?.getAttribute("data-label")).toBe(label);
    expect(badge()?.getAttribute("data-method")).toBe(method);
    expect(badge()?.textContent).toBe(text);
    expect(badge()?.getAttribute("title")).toBe(title);
  });

  it("no label, no badge", async () => {
    await render(review());
    expect(badge()).toBeNull();
  });
});
