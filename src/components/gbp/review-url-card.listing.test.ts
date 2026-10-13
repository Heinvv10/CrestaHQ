// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewUrlCard } from "./review-url-card";

/**
 * An EXTRA listing's review-link card (MULTI_LISTING_V1_PLAN.md PR 5),
 * rendered for real (jsdom): it proposes that listing's own link against
 * that listing's own adopted one, and its click is a compare-and-set naming
 * the listing. The main card beside it is unaffected.
 */

const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true, subAccount: {} as Record<string, unknown> }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

const B = "locations/extra-b";
const B_PROPOSED = "https://review.fixture.example/extra-b";
const B_OLD = "https://g.page/r/extra-b-old/review";
const MAIN_URL = "https://g.page/r/main/review";
const ADOPT = "/api/sub-accounts/sa1/google-review/adopt-listing-url";

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

function seed(bAdopted: string | null) {
  ctx.subAccount = {
    googleEnabledByAgency: true,
    googleListing: { locationName: "locations/main-1", title: "Fixture Main", newReviewUri: MAIN_URL },
    googleExtraListings: [{ locationName: B, title: "Fixture North", newReviewUri: B_PROPOSED }],
    googleReviewConfig: { reviewUrl: MAIN_URL, ...(bAdopted ? { listingUrls: { "extra-b": bAdopted } } : {}) },
  };
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, reviewUrl: B_PROPOSED }) });
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

const render = (locationName?: string) => act(async () => root.render(createElement(ReviewUrlCard, { locationName })));
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe("an extra listing's card", () => {
  it("nothing adopted for it: proposes its own link — the main's configured link is not its", async () => {
    seed(null);
    await render(B);
    const card = byId("gbp-listing-reviewurl-proposal");
    expect(card?.getAttribute("data-state")).toBe("proposal_available");
    expect(card?.getAttribute("data-location")).toBe(B);
    expect(card?.textContent).toContain(`Fixture North's Google review link is ${B_PROPOSED}`);
    expect(card?.textContent).not.toContain(MAIN_URL);
  });

  it("Use it posts a compare-and-set naming the listing", async () => {
    seed(B_OLD);
    await render(B);
    expect(byId("gbp-listing-reviewurl-proposal")?.textContent).toContain(B_OLD);
    await act(async () => (byId("gbp-listing-reviewurl-adopt") as HTMLButtonElement).click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ADOPT);
    expect(JSON.parse(String(init.body))).toEqual({ expectedCurrentUrl: B_OLD, locationName: B });
    // The doc never updates here (a stalled Listen stream): the card follows the route's 200.
    expect(byId("gbp-listing-reviewurl-matches")?.textContent).toBe("Review requests for Fixture North use its review link.");
    expect(byId("gbp-listing-reviewurl-proposal")).toBeNull();
  });

  it("adopted: a quiet confirmation naming the listing", async () => {
    seed(B_PROPOSED);
    await render(B);
    expect(byId("gbp-listing-reviewurl-matches")?.textContent).toBe("Review requests for Fixture North use its review link.");
  });

  it("the main card is unchanged by an extra's adopted link", async () => {
    seed(B_PROPOSED);
    await render();
    expect(byId("gbp-reviewurl-matches")?.textContent).toBe("Review requests use this listing's review link.");
    expect(byId("gbp-listing-reviewurl-matches")).toBeNull();
  });
});
