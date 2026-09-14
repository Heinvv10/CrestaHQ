// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_POLLS, POLL_MS, SentimentCard } from "./overview-sentiment";

/**
 * The Overview's sentiment card (SP5 b), every state, rendered for real
 * (jsdom). Only `fetch` (the Analyse-now route) is stubbed; the card's
 * reloads are observed through `onAnalysed`, and the test feeds it the next
 * overview state the way the page would.
 */

const RUN = "/api/sub-accounts/sa1/reputation/sentiment/run";
type Props = Parameters<typeof SentimentCard>[0];

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const onAnalysed = vi.fn();
const idle = { enabled: true, configured: true, running: false, lastRun: null };

function props(over: Partial<Props> = {}): Props {
  return {
    subAccountId: "sa1",
    isAdmin: true,
    reviewsAi: idle,
    sentiment: { positive: 3, neutral: 2, negative: 1, notAnalysed: 1, failed: 0 },
    onAnalysed,
    ...over,
  };
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 202, json: async () => ({ started: true, aiConfigured: true }) });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = (p: Props) => act(async () => root.render(createElement(SentimentCard, p)));
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const press = () => act(async () => (byId("rep-sentiment-analyse") as HTMLButtonElement).click());

describe("states", () => {
  it("gate off: says the agency can switch it on, no button", async () => {
    await render(props({ reviewsAi: { ...idle, enabled: false } }));
    expect(byId("rep-sentiment-gate-off")?.textContent).toBe("Reviews AI is off for this sub-account — your agency can switch it on.");
    expect(byId("rep-sentiment-analyse")).toBeNull();
  });

  it("AI not configured: says so, and does not promise analysis after each sync", async () => {
    await render(props({ reviewsAi: { ...idle, configured: false }, sentiment: { positive: 0, neutral: 0, negative: 0, notAnalysed: 6, failed: 0 } }));
    expect(byId("rep-sentiment-not-configured")?.textContent).toContain("AI isn't configured on this deployment");
    expect(byId("rep-sentiment-none")?.textContent).not.toContain("after each sync");
  });

  it("none analysed yet (configured): says new and edited reviews are analysed after each sync", async () => {
    await render(props({ sentiment: { positive: 0, neutral: 0, negative: 0, notAnalysed: 7, failed: 0 } }));
    expect(byId("rep-sentiment-none")?.textContent).toContain("None of the 7 reviews in this range has been analysed yet. New and edited reviews are analysed after each sync.");
  });

  it("no reviews in range", async () => {
    await render(props({ sentiment: { positive: 0, neutral: 0, negative: 0, notAnalysed: 0, failed: 0 } }));
    expect(byId("rep-sentiment-empty")).not.toBeNull();
  });

  it("labelled: the donut's counts, 'not analysed yet' and 'couldn't be analysed' apart", async () => {
    await render(props({ sentiment: { positive: 3, neutral: 2, negative: 1, notAnalysed: 1, failed: 2 } }));
    expect(byId("rep-sentiment-positive")?.getAttribute("data-count")).toBe("3");
    expect(byId("rep-sentiment-negative")?.getAttribute("data-count")).toBe("1");
    expect(byId("rep-sentiment-not-analysed")?.textContent).toBe("1 not analysed yet");
    expect(byId("rep-sentiment-failed")?.textContent).toContain("2 couldn't be analysed");
  });
});

describe("Analyse now", () => {
  it("members do not get the button", async () => {
    await render(props({ isAdmin: false }));
    expect(byId("rep-sentiment-analyse")).toBeNull();
  });

  it("202 → reloads the overview every few seconds until the run is over, then says what it did", async () => {
    vi.useFakeTimers();
    await render(props());
    await press();
    expect(fetchMock).toHaveBeenCalledWith(RUN, { method: "POST" });
    expect(onAnalysed).toHaveBeenCalledTimes(1);
    expect(byId("rep-sentiment-analyse")?.hasAttribute("disabled")).toBe(true);
    // The page reloads: still running → the card polls again after POLL_MS.
    await render(props({ reviewsAi: { ...idle, running: true } }));
    await act(async () => vi.advanceTimersByTime(POLL_MS));
    expect(onAnalysed).toHaveBeenCalledTimes(2);
    // The run finished.
    await render(props({ reviewsAi: { ...idle, lastRun: { classified: 5, skipped: 2, failed: 1, at: "2026-09-14T10:00:00.000Z" } } }));
    expect(byId("rep-sentiment-result")?.textContent).toBe(
      "Labelled 5 reviews. 2 reviews left for the next run. 1 review could not be analysed this time.",
    );
    await act(async () => vi.advanceTimersByTime(POLL_MS * 3));
    expect(onAnalysed).toHaveBeenCalledTimes(2); // polling stopped
  });

  it("gives up polling after a minute and says it is still running", async () => {
    vi.useFakeTimers();
    await render(props({ reviewsAi: { ...idle, running: true } }));
    await press();
    for (let i = 0; i < MAX_POLLS + 2; i++) await act(async () => vi.advanceTimersByTime(POLL_MS));
    expect(onAnalysed).toHaveBeenCalledTimes(MAX_POLLS + 1);
    expect(byId("rep-sentiment-result")?.textContent).toBe("Still analysing — the counts update when it finishes.");
  });

  it.each([
    [403, "gate_off", "Reviews AI is off for this sub-account — your agency can switch it on."],
    [403, "gate_off", "Google reviews are not enabled for this sub-account."],
    [409, "no_listing", "No Google listing is selected, so there are no reviews to analyse."],
    [409, "busy", "An analysis is already running — the counts update when it finishes."],
    [409, "too_soon", "Reviews were analysed less than a minute ago — try again shortly."],
  ])("a %s %s refusal shows the route's own message", async (status, code, error) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => ({ code, error }) });
    await render(props());
    await press();
    expect(byId("rep-sentiment-result")?.textContent).toBe(error);
    expect(onAnalysed).not.toHaveBeenCalled();
  });

  it("not configured: the result says only star-only reviews could be labelled", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ started: true, aiConfigured: false }) });
    await render(props());
    await press();
    await render(props({ reviewsAi: { ...idle, lastRun: { classified: 1, skipped: 6, failed: 0, at: "2026-09-14T10:00:00.000Z" } } }));
    expect(byId("rep-sentiment-result")?.textContent).toContain("only star-only reviews can be labelled");
  });
});
