import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { stringsSentToClient } from "@/test/sent-to-client";

/**
 * The public funnel pages (/fn and its thank-you) through their real server
 * pages. The funnel's accent is written into dozens of styles and a CSS
 * variable; a stored value that is not the plain hex the save route writes
 * must reach none of them.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { default: FunnelLandingPage } = await import("./page");
const { default: FunnelThanksPage } = await import("./thanks/page");
const { FunnelSections } = await import("@/components/funnels/funnel-sections");
const { createElement } = await import("react");

const SA = "sa1";
const params = { params: Promise.resolve({ subAccountId: SA, slug: "launch" }) };
const section = (id: string, type: string, over: Record<string, unknown> = {}) => ({
  id, type, heading: `Heading ${id}`, subheading: "Sub", body: "Body", items: [{ title: "One", body: "First" }, { title: "Two", body: "Second" }],
  mediaUrl: null, ctaLabel: "Get it", deadline: null, ...over,
});
const SECTIONS = [
  section("s1", "hero"),
  section("s2", "benefits", { background: "accentSoft" }),
  section("s3", "features", { background: "dark" }),
  section("s4", "cta", { background: "accent" }),
];

function store(accent: unknown) {
  mem.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", labsEnabledByAgency: true });
  mem.seed(`subAccounts/${SA}/funnels/f1`, {
    slug: "launch", name: "Launch", status: "published", template: "sales",
    landing: { headline: "Buy", subheadline: "", bullets: [], videoUrl: null, imageUrl: null, ctaLabel: "Go" },
    sections: SECTIONS, productId: null, checkoutPageId: null, ctaUrl: "https://example.com/buy",
    topBanner: "Launch week", thanks: { headline: "Thanks", body: "Done", redirectUrl: "https://example.com/next" },
    appearance: { theme: "light", accent, hideChrome: false, hideTitle: false },
  });
}

const PAGES = {
  "the landing page": () => FunnelLandingPage(params),
  "the thank-you page": () => FunnelThanksPage(params),
} as const;

const HOSTILE = [
  ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
  ["a hex followed by more CSS", "#7c3aed;background:url(https://evil.example/x)"],
  ["a CSS function", "url(https://evil.example/x)"],
  ["markup", '"><script src="https://evil.example/x"></script>'],
  ["a 3-digit hex, which the alpha suffixes would corrupt", "#f50"],
  ["a non-string", ["#aabbcc"]],
] as const;
/** Strings only a hostile fixture carries (the page's own CSS has `position:fixed`, so that is not one). */
const BAD = /evil\.example|#aabbcc/;

beforeEach(() => mem.clear());

describe.each(Object.keys(PAGES) as (keyof typeof PAGES)[])("the funnel's accent on %s", (name) => {
  const open = async () => renderToStaticMarkup((await PAGES[name]()) as ReactElement);

  it.each(HOSTILE)("ignores a stored accent that is %s", async (_label, accent) => {
    store("#7c3aed");
    const plain = await open();
    store(accent);
    const html = await open();
    expect(html).not.toMatch(BAD);
    expect(stringsSentToClient(await PAGES[name]()).filter((s) => BAD.test(s))).toEqual([]);
    // Exactly the default-accent page.
    expect(html).toBe(plain);
  });

  it("uses a real accent", async () => {
    store("#0ea5e9");
    const html = await open();
    expect(html).toContain("#0ea5e9");
    expect(html).not.toContain("#7c3aed");
  });
});

describe("FunnelSections, given an accent the pages would have dropped", () => {
  const ctx = (accent: unknown) => ({ accent, dark: false, ctaHref: "https://example.com/buy", defaultCta: "Go", t: { bodyStack: "system-ui", headStack: "system-ui", body: 16, h1: 44, h2: 30, lead: 18 } });
  const render = (accent: unknown) => renderToStaticMarkup(createElement(FunnelSections, { sections: SECTIONS, ctx: ctx(accent) } as never));

  it.each(HOSTILE)("ignores an accent that is %s", (_label, accent) => {
    const html = render(accent);
    expect(html).not.toMatch(BAD);
    expect(html).toBe(render("#7c3aed"));
  });

  it("uses a real accent", () => {
    expect(render("#0ea5e9")).toContain("#0ea5e9");
  });
});
