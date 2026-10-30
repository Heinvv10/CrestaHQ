import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * instrumentBroadcastHtml over an in-memory Firestore: which links get
 * wrapped, the two caps (per email, per broadcast), both unsubscribe
 * exclusions separately, and concurrent steps creating the same link doc.
 */

const mem = await vi.hoisted(async () => {
  const { createMemoryFirestore } = await import("@/test/memory-firestore");
  return createMemoryFirestore();
});
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";

const {
  instrumentBroadcastHtml,
  linkKeyFor,
  MAX_INSTRUMENTED_HTML_CHARS,
  MAX_LINK_DOCS_PER_BROADCAST,
  MAX_TRACKED_LINKS,
} = await import("./email-tracking");

const UNSUB = "https://app.test/u/tok-c1";

const instrument = (html: string, over: Record<string, unknown> = {}) =>
  instrumentBroadcastHtml({
    html,
    broadcastId: "b1",
    contactId: "c1",
    agencyId: "ag1",
    subAccountId: "sa1",
    tracking: { clicks: true },
    unsubscribeLink: UNSUB,
    ...over,
  });

const a = (href: string) => `<a href="${href}">x</a>`;
const tracked = (html: string) => html.match(/https:\/\/app\.test\/t\/c\//g)?.length ?? 0;
const links = () => mem.list("broadcasts/b1/links");

beforeEach(() => {
  mem.clear();
  mem.seed("broadcasts/b1", { agencyId: "ag1", subAccountId: "sa1", totals: {} });
});

describe("instrumentBroadcastHtml — caps", () => {
  it(`tracks the first ${MAX_TRACKED_LINKS} distinct links of an email and leaves the 51st alone`, async () => {
    const hrefs = Array.from({ length: MAX_TRACKED_LINKS + 1 }, (_, i) => `https://a.test/${i}`);
    const out = await instrument(hrefs.map(a).join(""));
    expect(tracked(out)).toBe(MAX_TRACKED_LINKS);
    expect(out).toContain(a(`https://a.test/${MAX_TRACKED_LINKS}`));
    expect(links()).toHaveLength(MAX_TRACKED_LINKS);
  });

  it("stops creating link docs at the broadcast's cap; links that already have one stay tracked", async () => {
    mem.seed("broadcasts/b1", {
      agencyId: "ag1",
      subAccountId: "sa1",
      trackedLinkCount: MAX_LINK_DOCS_PER_BROADCAST - 1,
    });
    mem.seed(`broadcasts/b1/links/${linkKeyFor("https://a.test/old")}`, { url: "https://a.test/old" });
    const out = await instrument(
      [a("https://a.test/old"), a("https://a.test/new1"), a("https://a.test/new2")].join(""),
    );
    expect(tracked(out)).toBe(2);
    expect(out).toContain(a("https://a.test/new2"));
    expect(mem.read("broadcasts/b1")!.trackedLinkCount).toBe(MAX_LINK_DOCS_PER_BROADCAST);
    expect(links()).toHaveLength(2);
  });

  it("sends a body over the size cap untracked — no link docs, no pixel", async () => {
    const html = a("https://a.test/1") + " ".repeat(MAX_INSTRUMENTED_HTML_CHARS);
    const out = await instrument(html, { tracking: { opens: true, clicks: true } });
    expect(out).toBe(html);
    expect(links()).toHaveLength(0);
  });
});

describe("instrumentBroadcastHtml — the unsubscribe link", () => {
  it("leaves the recipient's own unsubscribe URL alone even on another host (exact-match branch)", async () => {
    const elsewhere = "https://optout.other.test/stop/tok-c1";
    const out = await instrument(a(elsewhere), { unsubscribeLink: elsewhere });
    expect(out).toBe(a(elsewhere));
    expect(links()).toHaveLength(0);
  });

  it("leaves any /u/ link on this deployment alone, however the path is spelled (host branch)", async () => {
    for (const href of [
      "https://app.test/u/someone-else",
      "https://app.test/U/tok",
      "https://app.test//u/tok",
      "https://app.test/%75/tok",
      "https://app.test/%55/tok",
    ]) {
      expect(await instrument(a(href)), href).toBe(a(href));
    }
    expect(links()).toHaveLength(0);
  });

  it("tracks a client site's own /u/ page on another host", async () => {
    const out = await instrument(a("https://client.example/u/profile"));
    expect(tracked(out)).toBe(1);
  });
});

describe("instrumentBroadcastHtml — link docs", () => {
  it("two steps creating the same new link concurrently make one doc, and both emails are tracked", async () => {
    const [one, two] = await Promise.all([
      instrument(a("https://a.test/shared")),
      instrument(a("https://a.test/shared"), { contactId: "c2", unsubscribeLink: "https://app.test/u/tok-c2" }),
    ]);
    expect(tracked(one)).toBe(1);
    expect(tracked(two)).toBe(1);
    expect(links()).toHaveLength(1);
    expect(mem.read("broadcasts/b1")!.trackedLinkCount).toBe(1);
  });

  it("throws — so the step sends nothing — when the create transaction fails", async () => {
    const spy = vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(new Error("firestore down"));
    await expect(instrument(a("https://a.test/1"))).rejects.toThrow("firestore down");
    spy.mockRestore();
  });

  it("does no transaction when every link already has its doc", async () => {
    mem.seed(`broadcasts/b1/links/${linkKeyFor("https://a.test/1")}`, { url: "https://a.test/1" });
    const spy = vi.spyOn(mem.db, "runTransaction");
    expect(tracked(await instrument(a("https://a.test/1")))).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
