// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentimentCard } from "./overview-sentiment";

/**
 * The Overview's sentiment card (SP5 b), every state, rendered for real
 * (jsdom). Only `fetch` (the Analyse-now route) is stubbed.
 */

const RUN = "/api/sub-accounts/sa1/reputation/sentiment/run";
type Props = Parameters<typeof SentimentCard>[0];

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const onAnalysed = vi.fn();

function props(over: Partial<Props> = {}): Props {
  return {
    subAccountId: "sa1",
    isAdmin: true,
    reviewsAi: { enabled: true, configured: true },
    sentiment: { positive: 3, neutral: 2, negative: 1, notAnalysed: 1 },
    onAnalysed,
    ...over,
  };
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    ok: true, status: 200, json: async () => ({ outcome: { status: "ran", aiConfigured: true, classified: 2, skipped: 0, failed: 0 } }),
  });
  onAnalysed.mockReset();
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

const render = (p: Props) => act(async () => root.render(createElement(SentimentCard, p)));
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe("states", () => {
  it("gate off: says the agency can switch it on, no button", async () => {
    await render(props({ reviewsAi: { enabled: false, configured: true } }));
    expect(byId("rep-sentiment-gate-off")?.textContent).toBe("Reviews AI is off for this sub-account — your agency can switch it on.");
    expect(byId("rep-sentiment-analyse")).toBeNull();
    expect(byId("rep-sentiment-donut")).toBeNull();
  });

  it("AI not configured: says so; star-only labels still count", async () => {
    await render(props({ reviewsAi: { enabled: true, configured: false }, sentiment: { positive: 1, neutral: 0, negative: 0, notAnalysed: 6 } }));
    expect(byId("rep-sentiment-not-configured")?.textContent).toContain("AI isn't configured on this deployment");
    expect(byId("rep-sentiment-positive")?.getAttribute("data-count")).toBe("1");
  });

  it("none analysed yet", async () => {
    await render(props({ sentiment: { positive: 0, neutral: 0, negative: 0, notAnalysed: 7 } }));
    expect(byId("rep-sentiment-none")?.textContent).toContain("None of the 7 reviews in this range has been analysed yet");
    expect(byId("rep-sentiment-donut")).toBeNull();
  });

  it("no reviews in range", async () => {
    await render(props({ sentiment: { positive: 0, neutral: 0, negative: 0, notAnalysed: 0 } }));
    expect(byId("rep-sentiment-empty")).not.toBeNull();
  });

  it("labelled: the donut's counts and the not-analysed remainder", async () => {
    await render(props());
    expect(byId("rep-sentiment-donut")).not.toBeNull();
    expect(byId("rep-sentiment-positive")?.getAttribute("data-count")).toBe("3");
    expect(byId("rep-sentiment-neutral")?.getAttribute("data-count")).toBe("2");
    expect(byId("rep-sentiment-negative")?.getAttribute("data-count")).toBe("1");
    expect(byId("rep-sentiment-not-analysed")?.textContent).toBe("1 not analysed yet");
  });
});

describe("Analyse now", () => {
  it("members do not get the button", async () => {
    await render(props({ isAdmin: false }));
    expect(byId("rep-sentiment-analyse")).toBeNull();
  });

  it("an admin's press runs the route, says what happened, and reloads the overview", async () => {
    await render(props());
    await act(async () => (byId("rep-sentiment-analyse") as HTMLButtonElement).click());
    expect(fetchMock).toHaveBeenCalledWith(RUN, { method: "POST" });
    expect(byId("rep-sentiment-result")?.textContent).toBe("Analysed 2 reviews.");
    expect(onAnalysed).toHaveBeenCalledTimes(1);
  });

  it("a refusal is shown as the route's message", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: "too_soon", error: "Reviews were analysed less than a minute ago — try again shortly." }) });
    await render(props());
    await act(async () => (byId("rep-sentiment-analyse") as HTMLButtonElement).click());
    expect(byId("rep-sentiment-result")?.textContent).toBe("Reviews were analysed less than a minute ago — try again shortly.");
    expect(onAnalysed).not.toHaveBeenCalled();
  });
});
