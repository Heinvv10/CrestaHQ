// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewUrlCard } from "./review-url-card";

/**
 * The review-request link reconciliation card, rendered for real (jsdom) from
 * the live sub-account doc; only `fetch` and the context are stubbed. It
 * proposes, it never applies on its own: the configured link changes only
 * on the admin's click, compare-and-set on the URL they were shown.
 */

const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true, subAccount: {} as Record<string, unknown> }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

const LISTING = "https://review.fixture.example/fake-gqeberha";
const EXISTING = "https://g.page/r/e2e-existing/review";
const ADOPT = "/api/sub-accounts/sa1/google-review/adopt-listing-url";

let container: HTMLDivElement;
let root: Root;
let adoptResult: { status: number; body: unknown };
const fetchMock = vi.fn();

function seed(reviewUrl: string | null, newReviewUri: string | null, gateOn = true) {
  ctx.subAccount = {
    googleEnabledByAgency: gateOn,
    googleListing: { locationName: "locations/l1", newReviewUri },
    ...(reviewUrl ? { googleReviewConfig: { reviewUrl } } : {}),
  };
}

beforeEach(() => {
  ctx.isAdmin = true;
  adoptResult = { status: 200, body: { ok: true, reviewUrl: LISTING } };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url !== ADOPT || init?.method !== "POST") throw new Error(`unexpected fetch ${url}`);
    return { ok: adoptResult.status < 400, status: adoptResult.status, json: async () => adoptResult.body };
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

const render = () => act(async () => root.render(createElement(ReviewUrlCard)));
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const adoptPosts = () => fetchMock.mock.calls.filter(([u]) => u === ADOPT).map(([, i]) => JSON.parse(String(i.body)));

describe("states", () => {
  it("none — the listing has no review link: nothing shown", async () => {
    seed(EXISTING, null);
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("proposal_available — offers the listing's link, applies nothing", async () => {
    seed(null, LISTING);
    await render();
    const card = byId("gbp-reviewurl-proposal");
    expect(card?.getAttribute("data-state")).toBe("proposal_available");
    expect(card?.textContent).toContain(`Your selected Google listing's review link is ${LISTING}`);
    expect(byId("gbp-reviewurl-adopt")?.textContent).toBe("Use it");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("differs — shows both links and an explicit replace", async () => {
    seed(EXISTING, LISTING);
    await render();
    const card = byId("gbp-reviewurl-proposal");
    expect(card?.getAttribute("data-state")).toBe("differs");
    expect(card?.textContent).toContain(EXISTING);
    expect(card?.textContent).toContain(LISTING);
    expect(byId("gbp-reviewurl-adopt")?.textContent).toBe("Replace with listing link");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches — a quiet confirmation, nothing to click", async () => {
    seed(LISTING, LISTING);
    await render();
    expect(byId("gbp-reviewurl-matches")?.textContent).toContain("listing's review link");
    expect(byId("gbp-reviewurl-adopt")).toBeNull();
  });

  it("is admin-only", async () => {
    ctx.isAdmin = false;
    seed(EXISTING, LISTING);
    await render();
    expect(container.innerHTML).toBe("");
  });
});

describe("adopting", () => {
  it("one click → one compare-and-set POST on the URL that was shown", async () => {
    seed(EXISTING, LISTING);
    await render();
    await act(async () => (byId("gbp-reviewurl-adopt") as HTMLButtonElement).click());
    expect(adoptPosts()).toEqual([{ expectedCurrentUrl: EXISTING }]);
    // The doc never updates here (a stalled Listen stream): the card follows the route's 200.
    expect(byId("gbp-reviewurl-matches")?.textContent).toContain("listing's review link");
    expect(byId("gbp-reviewurl-proposal")).toBeNull();
    expect(byId("gbp-reviewurl-adopt")).toBeNull();
  });

  it("a snapshot that lands after the adopt takes over from the route's answer", async () => {
    seed(EXISTING, LISTING);
    await render();
    await act(async () => (byId("gbp-reviewurl-adopt") as HTMLButtonElement).click());
    seed(EXISTING, "https://review.fixture.example/changed-again");
    await render();
    expect(byId("gbp-reviewurl-matches")).toBeNull();
    expect(byId("gbp-reviewurl-proposal")?.getAttribute("data-state")).toBe("differs");
  });

  it("the configured link moved to something else while the proposal stayed: the doc wins", async () => {
    seed(EXISTING, LISTING);
    await render();
    await act(async () => (byId("gbp-reviewurl-adopt") as HTMLButtonElement).click());
    seed("https://g.page/r/someone-else/review", LISTING);
    await render();
    expect(byId("gbp-reviewurl-matches")).toBeNull();
    expect(byId("gbp-reviewurl-proposal")?.getAttribute("data-state")).toBe("differs");
  });

  it("a link reset to what it was before the adopt is not mistaken for that adopt", async () => {
    seed(EXISTING, LISTING);
    await render();
    await act(async () => (byId("gbp-reviewurl-adopt") as HTMLButtonElement).click());
    seed(LISTING, LISTING); // the snapshot lands: adopted
    await render();
    expect(byId("gbp-reviewurl-matches")).not.toBeNull();
    seed(EXISTING, LISTING); // another admin puts the old link back
    await render();
    expect(byId("gbp-reviewurl-matches")).toBeNull();
    expect(byId("gbp-reviewurl-proposal")?.getAttribute("data-state")).toBe("differs");
  });

  it("a proposal that changed and changed back is not mistaken for the adopt", async () => {
    seed(EXISTING, LISTING);
    await render();
    await act(async () => (byId("gbp-reviewurl-adopt") as HTMLButtonElement).click());
    seed(EXISTING, "https://review.fixture.example/changed-again");
    await render();
    seed(EXISTING, LISTING); // the proposal is back, the configured link never moved
    await render();
    expect(byId("gbp-reviewurl-matches")).toBeNull();
    expect(byId("gbp-reviewurl-proposal")?.getAttribute("data-state")).toBe("differs");
  });

  it("with nothing configured, sends expectedCurrentUrl null", async () => {
    seed(null, LISTING);
    await render();
    await act(async () => (byId("gbp-reviewurl-adopt") as HTMLButtonElement).click());
    expect(adoptPosts()).toEqual([{ expectedCurrentUrl: null }]);
  });

  it("changed meanwhile → says so inline with the current link", async () => {
    adoptResult = { status: 409, body: { code: "changed", currentUrl: "https://g.page/r/someone-else/review", error: "x" } };
    seed(EXISTING, LISTING);
    await render();
    await act(async () => (byId("gbp-reviewurl-adopt") as HTMLButtonElement).click());
    const error = byId("gbp-reviewurl-error")?.textContent ?? "";
    expect(error).toContain("changed");
    expect(error).toContain("https://g.page/r/someone-else/review");
    expect(byId("gbp-reviewurl-matches")).toBeNull();
    expect(byId("gbp-reviewurl-proposal")).not.toBeNull();
  });
});

describe("agency gate", () => {
  it("is hidden while the agency gate is off — the adopt route would refuse anyway", async () => {
    seed(EXISTING, LISTING, false);
    await render();
    expect(container.innerHTML).toBe("");
  });
});
