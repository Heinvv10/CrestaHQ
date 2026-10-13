// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankWebsiteConfig, type WebsiteDoc } from "@/types/website";
import { WebsiteBuilder } from "./website-builder";

/**
 * The site card (WS-6): which actions each status offers — no Rebuild on a
 * live site — that it opens the wizard and the after-publish dialogs, and
 * that a stored address or colour reaches an href or style only when valid.
 * The wizard's own steps and saves are in website-wizard.test.ts; here
 * `fetch` only answers Re-check now.
 */

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("fetch", fetchMock);
  HTMLElement.prototype.scrollTo = () => {};
  fetchMock.mockReset();
  for (const t of Object.values(toasts)) t.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  vi.unstubAllGlobals();
});

const site = (patch: Partial<WebsiteDoc> = {}): WebsiteDoc =>
  ({
    id: "site1",
    agencyId: "ag1",
    subAccountId: "sa1",
    name: "Acme",
    status: "draft",
    gitpageJobId: null,
    liveUrl: null,
    wizardStep: null,
    config: blankWebsiteConfig(),
    ...patch,
  }) as WebsiteDoc;

type CardProps = Partial<React.ComponentProps<typeof WebsiteBuilder>>;
const render = (doc: WebsiteDoc, props: CardProps = {}) =>
  act(async () =>
    root.render(createElement(WebsiteBuilder, { subAccountId: "sa1", doc, gateBlocked: false, ...props })),
  );
const labels = () =>
  Array.from(container.querySelectorAll("button, a")).map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "");
const button = (text: string) => {
  const hit = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!hit) throw new Error(`no button "${text}"`);
  return hit;
};
const dialogTitle = () => document.body.querySelector("[data-slot=dialog-title]")?.textContent ?? null;
const LIVE = "https://acme.gitlab.io/site";

describe("WebsiteBuilder — actions per status", () => {
  it.each([
    ["a fresh draft", site(), ["Start setup", "Remove website"]],
    ["a resumed draft", site({ wizardStep: "look" }), ["Continue setup", "Remove website"]],
    ["a queued build", site({ status: "queued", gitpageJobId: "b1" }), ["Re-check now"]],
    ["a build in progress", site({ status: "building", gitpageJobId: "b1" }), ["Re-check now"]],
    ["a failed build gitpage refused", site({ status: "failed" }), ["Try again", "Remove website"]],
    ["a failed build that can still finish", site({ status: "failed", gitpageJobId: "b1" }), ["Re-check now", "Try again", "Remove website"]],
    ["a live site", site({ status: "ready", gitpageJobId: "b1", liveUrl: LIVE }), ["Show URL", "Add custom domain", "Visit", "Edit site", "Remove website", "https://search.google.com/search-console"]],
  ])("%s offers exactly its actions", async (_, doc, expected) => {
    await render(doc);
    expect(labels()).toEqual(expected);
  });

  it("never offers a rebuild on a live site", async () => {
    await render(site({ status: "ready", gitpageJobId: "b1", liveUrl: LIVE, wizardStep: "review" }));
    expect(container.textContent).not.toMatch(/Rebuild|Try again|setup/);
  });

  it("hides setup and Try again while the website-builder key is missing", async () => {
    await render(site(), { gateBlocked: true });
    expect(labels()).toEqual(["Remove website"]);
    await render(site({ status: "failed" }), { gateBlocked: true });
    expect(labels()).toEqual(["Remove website"]);
  });

  it("says where a resumed draft was saved", async () => {
    await render(site({ wizardStep: "look" }));
    expect(container.textContent).toContain("Draft — saved at step 4 of 6: Look & feel");
    await render(site({ wizardStep: "nonsense" }));
    expect(container.textContent).toContain("Draft — not set up yet");
  });

  it("counts the steps as the wizard does, premium, even for an old standard draft", async () => {
    await render(site({ wizardStep: "story", config: { ...blankWebsiteConfig(), quality: "standard" } }));
    expect(container.textContent).toContain("Draft — saved at step 5 of 6: Your story");
  });

  it("a live site with no usable address offers nothing that needs one while the key is missing", async () => {
    await render(site({ status: "ready", gitpageJobId: "b1", liveUrl: null }), { gateBlocked: true });
    expect(labels()).toEqual(["Remove website"]);
  });
});

describe("WebsiteBuilder — what it opens", () => {
  it("opens a freshly added site's wizard on Start, and says so once so the page can clear it", async () => {
    const onAutoOpened = vi.fn();
    await render(site(), { autoOpen: true, onAutoOpened });
    expect(dialogTitle()).toBe("Start");
    expect(onAutoOpened).toHaveBeenCalledTimes(1);
    // The page answers by clearing autoOpen; a later re-render opens nothing new.
    await render(site(), { autoOpen: false, onAutoOpened });
    expect(onAutoOpened).toHaveBeenCalledTimes(1);
  });

  it("does not open the wizard while the key is missing, nor report it as opened", async () => {
    const onAutoOpened = vi.fn();
    await render(site(), { autoOpen: true, gateBlocked: true, onAutoOpened });
    expect(dialogTitle()).toBeNull();
    expect(onAutoOpened).not.toHaveBeenCalled();
  });

  it("Try again opens the wizard on Review", async () => {
    await render(site({ status: "failed" }));
    await act(async () => button("Try again").click());
    expect(dialogTitle()).toBe("Review & build");
  });

  it("opens the domain and edit windows on a live site", async () => {
    await render(site({ status: "ready", gitpageJobId: "b1", liveUrl: LIVE }));
    await act(async () => button("Add custom domain").click());
    expect(dialogTitle()).toBe("Custom domain");
    await act(async () => button("Close").click());
    await act(async () => button("Edit site").click());
    expect(Array.from(document.body.querySelectorAll("[data-slot=dialog-title]")).map((t) => t.textContent)).toContain("Edit this website");
  });

  it.each([
    [{ deferred: "in-flight", rescheduled: true }, "success", "Still building — restarted the poll loop."],
    [{ deferred: "in-flight" }, "success", "Still building — status refreshed."],
    [{}, "info", "Nothing to re-check — this site isn't building."],
    [{ settled: "ready" }, "success", "Build is live — URL updated."],
  ] as const)("Re-check now reports %j", async (payload, kind, message) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload });
    await render(site({ status: "building", gitpageJobId: "b1" }));
    await act(async () => button("Re-check now").click());
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/website/site1/poll-now", { method: "POST" });
    expect(toasts[kind]).toHaveBeenCalledWith(message);
  });
});

describe("WebsiteBuilder — stored values at the sinks", () => {
  it("links only an https address", async () => {
    await render(site({ status: "ready", gitpageJobId: "b1", liveUrl: "javascript:alert(1)" }));
    // No usable address: nothing links to it, nothing that needs one shows,
    // and the card says why and offers a way out rather than a dead end.
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(labels()).toEqual(["Try again", "Remove website"]);
    expect(container.textContent).toContain("Marked live, but this site has no usable https address");
    await act(async () => button("Try again").click());
    expect(dialogTitle()).toBe("Review & build");
    await render(site({ status: "ready", gitpageJobId: "b1", liveUrl: LIVE, customDomain: "www.acme.test" }));
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://www.acme.test/", "https://www.acme.test/", "https://search.google.com/search-console"]);
  });

  it.each([
    ["#00ff00", "rgb(0, 255, 0)"],
    ["red", "rgb(124, 58, 237)"],
    ["#0f0", "rgb(124, 58, 237)"],
    ["#00ff00;background:url(https://x.test/a)", "rgb(124, 58, 237)"],
    [null, "rgb(124, 58, 237)"],
  ])("paints the chat-bot badge from %j only as #RRGGBB", async (accent, color) => {
    await render(site(), { chatSource: { accent } });
    const badge = container.querySelector<HTMLElement>('[aria-label="Chat bot source"]');
    expect(badge?.style.color).toBe(color);
    expect(badge?.style.backgroundImage).toBe("");
  });

  it("describes the badge for screen readers and shows the explanation on a tap", async () => {
    await render(site(), { chatSource: { accent: "#00ff00" } });
    const badge = container.querySelector<HTMLButtonElement>('button[aria-label="Chat bot source"]')!;
    const tip = Array.from(container.querySelectorAll('[role="tooltip"]')).find((t) => t.id === badge.getAttribute("aria-describedby"));
    expect(tip?.textContent).toContain("The chat bot is based on this site");
    expect(tip?.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    await act(async () => badge.click());
    expect(tip?.className).toMatch(/(^|\s)opacity-100(\s|$)/);
    expect(tip?.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    await act(async () => badge.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(tip?.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    // A second click hides it too; keyboard focus alone never pins it open
    // (only `shown` and hover decide), so Escape and that click both work.
    await act(async () => badge.click());
    await act(async () => badge.click());
    expect(tip?.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(tip?.className).not.toContain("focus-within");
  });

  it("shows no badge on a site the chat bot did not learn from", async () => {
    await render(site());
    expect(container.querySelector('[aria-label="Chat bot source"]')).toBeNull();
  });
});
