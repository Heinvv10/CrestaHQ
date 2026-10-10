import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { contrast, hexToRgb, over, parseRgba } from "@/test/contrast";
import { CHECKOUT_THEMES } from "@/lib/checkout/themes";

/**
 * The public checkout page through its real loader: a preset restyles it
 * from the preset table alone, and a page with no preset — or with a stored
 * preset or accent that is not what the app writes — falls back to Clean or
 * Midnight without anything stored reaching a style attribute.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { default: PublicCheckoutPage } = await import("./page");

const SA = "sa1";
const FIELDS = [
  { id: "f0", type: "text", label: "Name", placeholder: "Your name", required: true, options: [], mapsTo: "name" },
  { id: "f1", type: "email", label: "Email", placeholder: "", required: true, options: [], mapsTo: "email" },
  { id: "f2", type: "select", label: "Size", placeholder: "", required: false, options: ["S", "M"], mapsTo: null },
  { id: "f3", type: "textarea", label: "Notes", placeholder: "", required: false, options: [], mapsTo: null },
  { id: "f4", type: "sms_consent", label: "Consent", placeholder: "", required: true, options: [], mapsTo: null, consentText: "I agree to be contacted." },
];
const look = (theme: string, accent: string) => ({ theme, accent, hideChrome: false, hideTitle: false });

/** Published pages with no preset, by slug. */
const PAGES: Record<string, Record<string, unknown>> = {
  bare: {},
  full: { headline: "Buy the thing", subheadline: "It is good.", collectFields: FIELDS, bumpProductIds: ["bump1", "bump2"] },
  accent: { subheadline: "Blue one.", collectFields: FIELDS, bumpProductIds: ["bump1"], appearance: look("light", "#0ea5e9") },
  dark: { subheadline: "Dark one.", collectFields: FIELDS, bumpProductIds: ["bump1"], appearance: look("dark", "#22c55e") },
  noappearance: { subheadline: "No appearance field.", bumpProductIds: ["bump1"], appearance: undefined },
};

function seed(extra: Record<string, unknown> = {}): void {
  mem.clear();
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "Fixture", paymentsEnabledByAgency: true });
  const product = (id: string, over: Record<string, unknown> = {}) =>
    mem.seed(`products/${id}`, { subAccountId: SA, active: true, name: `Product ${id}`, unitPriceCents: 4900, currency: "USD", ...over });
  product("main");
  product("bump1", { bumpEligible: true, name: "Bump one", bumpHeadline: "Add the workbook", unitPriceCents: 1900 });
  product("bump2", { bumpEligible: true, name: "Bump two", description: "Plain description", unitPriceCents: 900 });
  for (const [slug, over] of Object.entries(PAGES)) {
    mem.seed(`subAccounts/${SA}/checkoutPages/${slug}`, {
      slug,
      name: `Page ${slug}`,
      status: "published",
      productId: "main",
      bumpProductIds: [],
      headline: "",
      subheadline: "",
      collectFields: [],
      autoTags: [],
      pipelineStageId: null,
      successUrl: null,
      appearance: look("light", "#7c3aed"),
      ...over,
      ...extra,
    });
  }
}

/** `key` is a slug, optionally with `?cancelled` (the Stripe cancel return). */
async function open(key: string): Promise<string> {
  const [slug, query] = key.split("?");
  return renderToStaticMarkup(
    (await PublicCheckoutPage({
      params: Promise.resolve({ subAccountId: SA, slug }),
      searchParams: Promise.resolve(query === "cancelled" ? { cancelled: "1" } : {}),
    })) as ReactElement,
  );
}

const KEYS = Object.keys(PAGES).flatMap((slug) => [slug, `${slug}?cancelled`]);
const openAll = async () => Object.fromEntries(await Promise.all(KEYS.map(async (k) => [k, await open(k)] as const)));

beforeEach(() => seed());

describe("a checkout page with no preset", () => {
  it("renders as Clean, with the page's own accent on the pay button", async () => {
    const html = await open("accent");
    expect(html).toContain('<main style="min-height:100vh;background:#fafafa;color:#18181b;');
    expect(html).toContain("border:none;background:#0ea5e9;color:#ffffff;");
    expect(html).toContain('<span style="color:#0ea5e9">');
  });

  it("renders a dark page as Midnight", async () => {
    const html = await open("dark");
    expect(html).toContain('<main style="min-height:100vh;background:#18181b;color:#fafafa;');
    expect(html).toContain("background:#18181b;color:#fafafa;box-sizing:border-box");
    expect(html).toContain("border:none;background:#22c55e;color:#ffffff;");
  });

  it.each([
    ["null", null],
    ["an id this build does not know", "bogus"],
    ["a name every object has", "constructor"],
    ["another name every object has", "__proto__"],
    ["a string shaped like markup", '"><script>alert(1)</script>'],
    ["a string shaped like CSS", "clean;background:url(https://evil.example/x)"],
    ["a number", 42],
    ["an object", { id: "ocean" }],
  ])("renders the same when the stored preset is %s", async (_label, themePreset) => {
    const expected = await openAll();
    seed({ themePreset });
    expect(await openAll()).toEqual(expected);
  });

  it.each([
    ["extra CSS declarations", "#7c3aed;position:fixed;inset:0;background:url(https://evil.example/x)"],
    ["a CSS function", "url(https://evil.example/x)"],
    ["markup", '"><script src="https://evil.example/x"></script>'],
    ["a colour name", "red"],
    ["a non-string", ["#aabbcc"]],
  ])("keeps a stored accent that is %s out of the page", async (_label, accent) => {
    seed({ appearance: look("light", accent as string) });
    const html = await open("full?cancelled");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("#aabbcc");
    // Clean's own accent instead.
    expect(html).toContain("border:none;background:#7c3aed;color:#ffffff;");
  });
});

describe("a checkout page with a preset", () => {
  it("styles the page and the form from the preset", async () => {
    seed({ themePreset: "noir-lime" });
    const html = await open("full?cancelled");
    expect(html).toContain('<main style="min-height:100vh;background:#050505;color:#f5f5f4;');
    expect(html).toContain(
      '<div style="background:#0f0f10;border:1px solid #222226;border-radius:4px;padding:28px 24px;box-shadow:0 0 0 1px rgba(204,255,0,0.04), 0 8px 30px rgba(0,0,0,0.6)">',
    );
    expect(html).toContain(
      '<h1 style="margin:0;font-size:24px;line-height:1.25;font-weight:800;text-transform:uppercase;letter-spacing:0.04em">',
    );
    expect(html).toContain('<p style="margin:8px 0 0;font-size:14.5px;line-height:1.6;color:#9a9a93">');
    // Inputs, tinted checkboxes, the bump box and the pay button.
    expect(html).toContain("border-radius:2px;border:1px solid #2c2c30;font-size:14px;font-family:inherit;background:#161617;color:#f5f5f4;");
    expect(html).toContain('<input type="checkbox" style="margin-top:2px;accent-color:#ccff00"/>');
    expect(html).toContain("padding:14px;border-radius:2px;cursor:pointer;border:2px dashed rgba(204,255,0,0.35);background:rgba(255,255,255,0.02)");
    expect(html).toContain('<span style="color:#ccff00">');
    expect(html).toContain(
      "border-radius:2px;border:none;background:#ccff00;color:#0a0a0a;font-size:15px;font-weight:700;font-family:inherit;text-transform:uppercase;letter-spacing:0.04em;",
    );
    expect(html).toContain("text-align:center;color:#6f6f68");
  });

  it("changes nothing but style: the same content in the same order", async () => {
    const text = (html: string) => html.replace(/ style="[^"]*"/g, "");
    const plain = await openAll();
    for (const themePreset of ["midnight", "noir-lime", "sunset", "ocean"]) {
      seed({ themePreset });
      for (const key of KEYS) {
        const html = await open(key);
        expect(html, `${themePreset} ${key}`).not.toBe(plain[key]);
        expect(text(html), `${themePreset} ${key}`).toBe(text(plain[key]));
      }
    }
  });

  it.each(Object.values(CHECKOUT_THEMES).map((t) => [t.label, t] as const))(
    "%s: the required mark and the cancel notice are readable on the card (4.5:1)",
    async (_label, theme) => {
      seed({ themePreset: theme.id });
      const html = await open("full?cancelled");
      const card = hexToRgb(theme.cardBg);

      const marks = [...html.matchAll(/<span style="color:(#[0-9a-f]{6})"> \*<\/span>/g)].map((m) => m[1]);
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) expect(contrast(hexToRgb(mark), card), `required mark ${mark}`).toBeGreaterThanOrEqual(4.5);

      const notice = /background:(rgba\([^)]*\));border:[^;]*;font-size:13px;color:(#[0-9a-f]{6})">Checkout was cancelled/.exec(html);
      expect(notice).not.toBeNull();
      const tint = parseRgba(notice![1]);
      expect(contrast(hexToRgb(notice![2]), over(tint.rgb, tint.alpha, card)), `cancel notice ${notice![2]}`).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("uses the preset's accent, not the page's own", async () => {
    seed({ themePreset: "ocean" });
    const html = await open("accent");
    expect(html).toContain("background:#027dbc;color:#ffffff;");
    expect(html).not.toContain("#0ea5e9");
  });
});
