import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { stringsSentToClient } from "@/test/sent-to-client";

/**
 * The funnel thank-you page's redirect, through the real server page. The
 * stored URL is written into a `<meta http-equiv="refresh">` (which React
 * does not sanitise) and a "go now" link; the save route checks only the
 * https prefix. A value that is not https on a public host, or that could
 * end or re-quote the refresh's `url=`, means no redirect at all.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { default: FunnelThanksPage } = await import("./page");

const SA = "sa1";
const params = { params: Promise.resolve({ subAccountId: SA, slug: "launch" }) };

function store(redirectUrl: unknown) {
  mem.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", labsEnabledByAgency: true });
  mem.seed(`subAccounts/${SA}/funnels/f1`, {
    slug: "launch", name: "Launch", status: "published", template: "sales", sections: [],
    thanks: { headline: "Thanks", body: "Done", redirectUrl },
    appearance: { theme: "light", accent: "#7c3aed", hideChrome: false, hideTitle: false },
  });
}
const open = async () => {
  const el = (await FunnelThanksPage(params)) as ReactElement;
  return { el, html: renderToStaticMarkup(el) };
};

const HOSTILE = [
  ["javascript:", "javascript:fetch('https://evil.example/x')"],
  ["data:", "data:text/html,<script src=https://evil.example/x></script>"],
  ["plain http", "http://evil.example/next"],
  ["a quote that re-quotes the refresh url", "https://ok.example/x';url=https://evil.example/"],
  ["a double quote", 'https://ok.example/x"evil.example'],
  ["whitespace", "https://ok.example/x url=https://evil.example/"],
  ["a loopback host", "https://127.0.0.1/evil.example"],
  ["a non-string", ["https://evil.example/"]],
] as const;
const BAD = /evil\.example|ok\.example|127\.0\.0\.1/;

beforeEach(() => mem.clear());

describe("the funnel thank-you redirect", () => {
  it.each(HOSTILE)("is dropped when the stored URL is %s", async (_label, redirectUrl) => {
    store(redirectUrl);
    const { el, html } = await open();
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("Taking you onward");
    expect(html).not.toMatch(BAD);
    expect(stringsSentToClient(el).filter((s) => BAD.test(s))).toEqual([]);
    // The page itself still renders.
    expect(html).toContain("Thanks");
  });

  it("keeps a real https redirect, in the refresh and the link", async () => {
    const url = "https://example.com/next?step=2&ref=(launch)";
    store(url);
    const { html } = await open();
    expect(html).toContain('<meta http-equiv="refresh" content="5;url=https://example.com/next?step=2&amp;ref=(launch)"/>');
    expect(html).toContain('href="https://example.com/next?step=2&amp;ref=(launch)"');
  });

  it("shows no redirect when none is stored", async () => {
    store(null);
    const { html } = await open();
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("Taking you onward");
  });
});
