import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { stringsSentToClient } from "@/test/sent-to-client";
import { CHECKOUT_THEMES } from "@/lib/checkout/themes";

/**
 * The checkout thank-you page through its real server page: it takes the
 * same resolved theme as the checkout page it follows, so it matches the
 * page's preset, and a stored accent reaches its styles only as a plain hex.
 * (It used to write `appearance.accent` straight into a style attribute.)
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { default: CheckoutThanksPage } = await import("./page");

const SA = "sa1";
const look = (theme: string, accent: unknown) => ({ theme, accent, hideChrome: false, hideTitle: false });
const store = (page: Record<string, unknown>) => mem.seed(`subAccounts/${SA}/checkoutPages/p1`, { slug: "offer", status: "published", ...page });
const tree = () => CheckoutThanksPage({ params: Promise.resolve({ subAccountId: SA, slug: "offer" }) });
const open = async () => renderToStaticMarkup((await tree()) as ReactElement);

const HOSTILE = [
  ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
  ["a hex followed by more CSS", "#7c3aed;background:url(https://evil.example/x)"],
  ["a CSS function", "url(https://evil.example/x)"],
  ["markup", '"><script src="https://evil.example/x"></script>'],
  ["a non-string", ["#aabbcc"]],
] as const;

beforeEach(() => mem.clear());

describe("the checkout thank-you page", () => {
  it.each(HOSTILE)("keeps a stored accent that is %s out of the markup and out of what is sent", async (_label, accent) => {
    store({ appearance: look("light", accent) });
    const html = await open();
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("#aabbcc");
    expect(stringsSentToClient(await tree()).filter((s) => /evil\.example|position:fixed|#aabbcc/.test(s))).toEqual([]);
    // Clean's own accent instead.
    expect(html).toContain("background:rgba(124,58,237,0.06);color:#7c3aed;");
  });

  it("keeps a real accent", async () => {
    store({ appearance: look("light", "#0ea5e9") });
    const html = await open();
    expect(html).toContain("background:#0ea5e90f;color:#0ea5e9;");
    expect(html).toContain("background:#fafafa;color:#18181b;");
  });

  it("follows a dark page saved before presets", async () => {
    store({ appearance: look("dark", "#22c55e") });
    const html = await open();
    expect(html).toContain("background:#18181b;color:#fafafa;");
    expect(html).toContain("color:#22c55e;");
    expect(html).toContain("line-height:1.6;color:#a1a1aa");
  });

  it.each(Object.values(CHECKOUT_THEMES).map((t) => [t.label, t] as const))("matches the %s preset", async (_label, theme) => {
    store({ themePreset: theme.id, appearance: look("light", "#0ea5e9") });
    const html = await open();
    expect(html).toContain(`background:${theme.pageBg};color:${theme.text};`);
    expect(html).toContain(`background:${theme.accentSoft};color:${theme.accent};`);
    expect(html).toContain(`line-height:1.6;color:${theme.muted}`);
    // The page's own accent no longer applies once a preset is chosen.
    expect(html).not.toContain("#0ea5e9");
  });

  it.each([["bogus"], ["constructor"], ["__proto__"], [42]])("treats an unknown stored preset (%s) as none", async (themePreset) => {
    store({ themePreset, appearance: look("light", "#0ea5e9") });
    expect(await open()).toContain("background:#0ea5e90f;color:#0ea5e9;");
  });

  it("renders the default look when the page is gone", async () => {
    const html = await open();
    expect(html).toContain("background:#fafafa;color:#18181b;");
    expect(html).toContain("Payment received");
  });
});
