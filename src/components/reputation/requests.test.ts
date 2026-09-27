// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

/**
 * Every state of Reputation → Requests, rendered for real (jsdom) from the
 * requests API payload; only `fetch`, the sub-account context and the send
 * dialog (tested in send-review-request.test.ts) are stubbed.
 */

vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ subAccountId: "sa1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...rest }, children),
}));
const sendButton = vi.hoisted(() => ({ onSent: null as null | (() => void) }));
vi.mock("./send-review-request", () => ({
  SendReviewRequestButton: ({ onSent }: { onSent: () => void }) => {
    sendButton.onSent = onSent;
    return createElement("button", { "data-testid": "rep-send-open" }, "Send Review Request");
  },
}));

import { ReputationRequests, type RequestRow } from "./requests";

const API = "/api/sub-accounts/sa1/reputation/requests";
const row = (id: string, over: Partial<RequestRow> = {}): RequestRow => ({
  id, contactId: `c_${id}`, contactName: `Fixture ${id}`, channel: "sms", source: "dispatcher", trigger: "manual",
  status: "sent", failureKind: null, sentAt: "2026-09-14T08:05:00.000Z", clickedAt: null, tracked: false, reminder: null, ...over,
});

let pages: Record<string, { status?: number; body: unknown }>;
const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  pages = { "": { body: { requests: [row("a"), row("b", { contactName: null }), row("c", { source: "workflow", trigger: null, channel: "whatsapp", status: "failed", failureKind: "send_failed" })], nextCursor: null } } };
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (!url.startsWith(`${API}?`)) throw new Error(`unexpected fetch ${url}`);
    const page = pages[url.slice(API.length + 1)];
    if (!page) throw new Error(`no page for ${url}`);
    return { ok: (page.status ?? 200) < 400, status: page.status ?? 200, json: async () => page.body };
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

const render = () => act(async () => root.render(createElement(ReputationRequests)));
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const text = (id: string) => byId(id)?.textContent ?? null;
const rows = () => [...container.querySelectorAll('[data-testid="rep-req-row"]')];
const within = (el: Element, id: string) => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
async function change(el: Element | null, value: string) {
  await act(async () => {
    const input = el as HTMLInputElement | HTMLSelectElement;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}

describe("states", () => {
  it("loading, before the API answers", async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    await render();
    expect(byId("rep-req-loading")).not.toBeNull();
  });

  it("error, when the API fails", async () => {
    pages[""] = { status: 500, body: { error: "x" } };
    await render();
    expect(text("rep-req-error")).toContain("could not be loaded");
  });

  it("empty: nothing logged yet", async () => {
    pages[""] = { body: { requests: [], nextCursor: null } };
    await render();
    expect(text("rep-req-empty")).toBe("No review requests have been logged yet.");
  });

  it("the Failed filter says which failures are not in the log", async () => {
    pages["status=failed"] = { body: { requests: [], nextCursor: null } };
    await render();
    expect(byId("rep-req-failed-note")).toBeNull();
    await change(byId("rep-req-filter-status"), "failed");
    expect(text("rep-req-failed-note")).toBe(
      "Failed lists sends a provider rejected from workflows, broadcasts and the inbox. A Request review that could not be sent is not logged — the Send Review Request dialog shows why instead.",
    );
  });

  it("empty under filters, with and without older rows left to scan", async () => {
    pages["status=failed"] = { body: { requests: [], nextCursor: null } };
    pages["channel=email"] = { body: { requests: [], nextCursor: "r1000" } };
    await render();
    await change(byId("rep-req-filter-status"), "failed");
    expect(text("rep-req-empty")).toBe("No requests match these filters.");
    await change(byId("rep-req-filter-status"), "");
    await change(byId("rep-req-filter-channel"), "email");
    expect(text("rep-req-empty")).toContain("Load more to look further back");
    expect(byId("rep-req-more")).not.toBeNull();
  });
});

describe("the list", () => {
  it("one row per request: contact link, channel, sender, time, status", async () => {
    await render();
    expect(rows()).toHaveLength(3);
    const [a, b, c] = rows();
    expect(a.querySelector("a")?.getAttribute("href")).toBe("/sa/sa1/contacts/c_a");
    expect(a.textContent).toContain("Fixture a");
    expect(a.textContent).toContain("SMS");
    expect(a.textContent).toContain("Request review & triggers · manual");
    expect(a.textContent).toMatch(/14 Sept? 2026/);
    expect(a.getAttribute("data-status")).toBe("sent");
    expect(b.textContent).toContain("Deleted contact");
    expect(b.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("WhatsApp");
    expect(c.textContent).toContain("Workflows");
    expect(c.getAttribute("data-status")).toBe("failed");
    expect(c.textContent).toContain("Failed");
  });

  it("a contact outside the viewer's territories is named as such, without a link", async () => {
    pages[""] = { body: { requests: [row("h", { contactId: null, contactName: null })], nextCursor: null } };
    await render();
    expect(rows()[0].textContent).toContain("Outside your territories");
    expect(rows()[0].querySelector("a")).toBeNull();
  });

  it("a Load more answering after the filters changed never lands on the new list", async () => {
    let answerOld: (v: unknown) => void = () => {};
    pages[""] = { body: { requests: [row("a")], nextCursor: "ra" } };
    pages["status=failed"] = { body: { requests: [row("f", { status: "failed" })], nextCursor: null } };
    await render();
    fetchMock.mockImplementationOnce(() => new Promise((r) => (answerOld = r)));
    await act(async () => (byId("rep-req-more") as HTMLButtonElement).click());
    await change(byId("rep-req-filter-status"), "failed");
    await act(async () => answerOld({ ok: true, status: 200, json: async () => ({ requests: [row("old")], nextCursor: null }) }));
    expect(rows().map((r) => r.getAttribute("data-status"))).toEqual(["failed"]);
    expect(container.textContent).not.toContain("Fixture old");
  });

  it("clicks and reminders (SP5 d2): a Clicked status and a reminder column", async () => {
    // The scheduled reminder's nextAt is a fixed date, and the component treats
    // a nextAt that has gone stale as "Stopped — outcome unknown". Pin the clock
    // (Date only; real timers keep the async render working) so this fixture
    // does not expire.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    pages[""] = {
      body: {
        requests: [
          row("k", { tracked: true, clickedAt: "2026-09-14T09:00:00.000Z", reminder: { attempts: 1, maxRetries: 2, state: "stopped", stopReason: "clicked", nextAt: null, lastAttemptAt: null } }),
          row("s", { tracked: true, reminder: { attempts: 0, maxRetries: 2, state: "scheduled", stopReason: null, nextAt: "2026-09-16T08:05:00.000Z", lastAttemptAt: null } }),
          row("d", { reminder: { attempts: 2, maxRetries: 2, state: "done", stopReason: "retries_exhausted", nextAt: null, lastAttemptAt: null } }),
          row("o", { reminder: { attempts: 0, maxRetries: 2, state: "stopped", stopReason: "opted_out", nextAt: null, lastAttemptAt: null } }),
          row("n"),
        ],
        nextCursor: null,
      },
    };
    await render();
    const [k, sch, done, opt, none] = rows();
    expect(k.getAttribute("data-status")).toBe("clicked");
    expect(k.textContent).toContain("Clicked");
    expect(within(k, "rep-req-reminder")).toBe("Stopped: clicked · 1 of 2 sent");
    expect(within(sch, "rep-req-reminder")).toMatch(/^0 of 2 sent · next 16 Sept? 2026$/);
    expect(within(done, "rep-req-reminder")).toBe("Done · 2 of 2 sent");
    expect(within(opt, "rep-req-reminder")).toBe("Stopped: opted out · 0 of 2 sent");
    expect(within(none, "rep-req-reminder")).toBe("—");
  });

  it("a reminder stuck 'sending' for over 15 minutes reads as stopped, outcome unknown; a fresh one as sending", async () => {
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const r = (id: string, lastAttemptAt: string) =>
      row(id, { reminder: { attempts: 1, maxRetries: 2, state: "sending", stopReason: null, nextAt: null, lastAttemptAt } });
    pages[""] = { body: { requests: [r("old", old), r("fresh", fresh)], nextCursor: null } };
    await render();
    const [o, f] = rows();
    expect(within(o, "rep-req-reminder")).toBe("Stopped — outcome unknown · 1 of 2 sent");
    expect(within(f, "rep-req-reminder")).toBe("Sending · 1 of 2 sent");
  });

  it("a 'scheduled' reminder more than a day overdue reads as stopped, outcome unknown", async () => {
    const r = (id: string, nextAt: string) =>
      row(id, { reminder: { attempts: 0, maxRetries: 2, state: "scheduled", stopReason: null, nextAt, lastAttemptAt: null } });
    pages[""] = {
      body: { requests: [r("late", new Date(Date.now() - 25 * 3600_000).toISOString()), r("due", new Date(Date.now() - 3600_000).toISOString())], nextCursor: null },
    };
    await render();
    const [late, due] = rows();
    expect(within(late, "rep-req-reminder")).toBe("Stopped — outcome unknown · 0 of 2 sent");
    expect(within(due, "rep-req-reminder")).toMatch(/^0 of 2 sent · next /);
  });

  it("'—' explains itself: a tooltip and a legend under the table", async () => {
    await render();
    expect(rows()[0].querySelector('[data-testid="rep-req-reminder"]')?.getAttribute("title")).toContain("No reminders");
    expect(text("rep-req-reminder-legend")).toContain("Reminders go only with SMS requests sent by Request review");
  });

  it("the status filter offers Clicked", async () => {
    pages["status=clicked"] = { body: { requests: [], nextCursor: null } };
    await render();
    await change(byId("rep-req-filter-status"), "clicked");
    expect(fetchMock).toHaveBeenLastCalledWith(`${API}?status=clicked`, expect.anything());
  });

  it("a filter asks the server again with it", async () => {
    pages["source=workflow"] = { body: { requests: [row("w", { source: "workflow", trigger: null })], nextCursor: null } };
    await render();
    await change(byId("rep-req-filter-source"), "workflow");
    expect(fetchMock).toHaveBeenLastCalledWith(`${API}?source=workflow`, expect.anything());
    expect(rows().map((r) => r.getAttribute("data-source"))).toEqual(["workflow"]);
  });

  it("search narrows the loaded rows by contact name and says it only covers those", async () => {
    await render();
    expect(text("rep-req-search-note")).toContain("loaded below only");
    await change(byId("rep-req-search"), "fixture A");
    expect(rows()).toHaveLength(1);
    await change(byId("rep-req-search"), "nobody");
    expect(rows()).toHaveLength(0);
    expect(text("rep-req-no-match")).toContain("nobody");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Load more appends the next page from the cursor; a failed page says so", async () => {
    pages[""] = { body: { requests: [row("a")], nextCursor: "ra" } };
    pages["cursor=ra"] = { body: { requests: [row("b")], nextCursor: "rb" } };
    pages["cursor=rb"] = { status: 500, body: {} };
    await render();
    await act(async () => (byId("rep-req-more") as HTMLButtonElement).click());
    expect(rows().map((r) => r.textContent?.includes("Fixture b"))).toEqual([false, true]);
    await act(async () => (byId("rep-req-more") as HTMLButtonElement).click());
    expect(text("rep-req-more-error")).toContain("Couldn't load more");
    expect(rows()).toHaveLength(2);
  });

  it("a successful Send Review Request reloads the list", async () => {
    await render();
    expect(byId("rep-send-open")).not.toBeNull();
    await act(async () => sendButton.onSent?.());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("the listing a request was for (MULTI_LISTING_V1_PLAN.md PR 5)", () => {
  it("shows the extra listing's title on its row only", async () => {
    pages[""] = { body: { requests: [row("a", { listingTitle: "Fixture North" }), row("b", { listingTitle: null })], nextCursor: null } };
    await render();
    expect(rows().map((r) => within(r, "rep-req-listing"))).toEqual(["Fixture North", null]);
  });
});
