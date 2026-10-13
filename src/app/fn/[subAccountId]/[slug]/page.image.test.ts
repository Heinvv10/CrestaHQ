import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { stringsSentToClient } from "@/test/sent-to-client";

/**
 * A funnel section's stored image in background mode is written into CSS
 * `url(…)` on the public page. Through the real /fn page (which /fnh
 * delegates to): a value that could leave the `url(…)` token, or that is not
 * an https image on a public host, is dropped from the markup, from what is
 * handed on, and from the page's share image; a real one is kept.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { default: FunnelLandingPage, generateMetadata } = await import("./page");
const { FunnelSections } = await import("@/components/funnels/funnel-sections");
const { createElement } = await import("react");

const SA = "sa1";
const params = { params: Promise.resolve({ subAccountId: SA, slug: "launch" }) };
const section = (id: string, type: string, over: Record<string, unknown> = {}) => ({
  id, type, heading: `Heading ${id}`, subheading: "Sub", body: "Body", items: [],
  mediaUrl: null, ctaLabel: "Get it", deadline: null, ...over,
});
const sections = (mediaUrl: string) => [
  section("s1", "hero", { mediaUrl, mediaAsBackground: true }),
  section("s2", "image", { mediaUrl, mediaAsBackground: true, heading: "Interlude" }),
  section("s3", "cta"),
];

function store(mediaUrl: string) {
  mem.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", labsEnabledByAgency: true });
  mem.seed(`subAccounts/${SA}/funnels/f1`, {
    slug: "launch", name: "Launch", status: "published", template: "sales",
    landing: { headline: "Buy", subheadline: "", bullets: [], videoUrl: null, imageUrl: null, ctaLabel: "Go" },
    sections: sections(mediaUrl), productId: null, checkoutPageId: null, ctaUrl: "https://example.com/buy",
    thanks: { headline: "Thanks", body: "Done", redirectUrl: null },
    appearance: { theme: "light", accent: "#7c3aed", hideChrome: false, hideTitle: false },
  });
}

const HOSTILE = [
  ["a value that closes url( and adds a declaration", "x);background:url(https://evil.example/"],
  ["an https URL that closes url(", "https://img.example/a.jpg);background:url(https://evil.example/"],
  ["a quote", 'https://img.example/a.jpg"evil.example'],
  ["a backslash", "https://img.example/a.jpg\\29 evil.example"],
  ["a newline", "https://img.example/a.jpg\nbackground:url(https://evil.example/)"],
  ["plain http", "http://evil.example/a.jpg"],
  ["a loopback host", "https://127.0.0.1/evil.example.jpg"],
  ["localhost", "https://localhost/evil.example.jpg"],
  ["longer than the save route stores", `https://evil.example/${"a".repeat(500)}.jpg`],
] as const;
const BAD = /evil\.example/;
const GOOD = "https://images.example.com/photo.jpg?w=1200&q=80";

beforeEach(() => mem.clear());

describe("a funnel's background image on the public page", () => {
  it.each(HOSTILE)("drops one that is %s", async (_label, mediaUrl) => {
    store(mediaUrl);
    const el = (await FunnelLandingPage(params)) as ReactElement;
    const html = renderToStaticMarkup(el);
    expect(html).not.toMatch(BAD);
    expect(html).not.toContain("url(http");
    expect(stringsSentToClient(el).filter((s) => BAD.test(s))).toEqual([]);
    expect(JSON.stringify(await generateMetadata(params))).not.toMatch(BAD);
    // The page still renders, without the image (an image band with no
    // image renders nothing).
    expect(html).toContain("Heading s1");
  });

  it("keeps a real https image", async () => {
    store(GOOD);
    const el = (await FunnelLandingPage(params)) as ReactElement;
    const html = renderToStaticMarkup(el);
    expect(html).toContain("url(https://images.example.com/photo.jpg?w=1200&amp;q=80) center / cover no-repeat");
    expect(stringsSentToClient(el)).toContain(GOOD);
    expect(JSON.stringify(await generateMetadata(params))).toContain(GOOD);
  });
});

describe("FunnelSections, given a background image the page would have dropped", () => {
  const ctx = { accent: "#7c3aed", dark: false, ctaHref: "https://example.com/buy", defaultCta: "Go", t: { bodyStack: "system-ui", headStack: "system-ui", body: 16, h1: 44, h2: 30, lead: 18 } };
  const render = (mediaUrl: string) => renderToStaticMarkup(createElement(FunnelSections, { sections: sections(mediaUrl), ctx } as never));

  it.each(HOSTILE)("drops one that is %s", (_label, mediaUrl) => {
    const html = render(mediaUrl);
    expect(html).not.toMatch(BAD);
    expect(html).not.toContain("url(http");
  });

  it("keeps a real one", () => {
    expect(render(GOOD)).toContain("url(https://images.example.com/photo.jpg?w=1200&amp;q=80)");
  });
});
