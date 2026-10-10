import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import legacyMarkup from "@/test/checkout-legacy-markup.json";

/**
 * The public checkout page through its real loader: a page with no style
 * preset renders exactly as it did before presets existed, and a preset
 * restyles it from the preset table alone.
 *
 * `checkout-legacy-markup.json` is the markup this page produced for the
 * fixtures below at 4f16a2c0, the commit before presets were added. It is
 * the "before" half of the comparison and is never regenerated to make a
 * failure pass: a pre-preset page is meant to look the same for good.
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

/** The pages the stored markup was captured from, by slug. */
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

const golden = legacyMarkup as Record<string, string>;

beforeEach(() => seed());

describe("a checkout page with no preset", () => {
  it("covers every stored page, with and without the cancel notice", () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(PAGES).flatMap((s) => [s, `${s}?cancelled`]).sort());
  });

  it.each(Object.keys(golden))("renders %s byte for byte as it did before presets", async (key) => {
    expect(await open(key)).toBe(golden[key]);
  });

  it.each([
    ["null", null],
    ["an id this build does not know", "bogus"],
    ["a name every object has", "constructor"],
    ["a string shaped like markup", '"><script>alert(1)</script>'],
    ["a string shaped like CSS", "clean;background:url(https://evil.example/x)"],
    ["a number", 42],
  ])("renders the same when the stored preset is %s", async (_label, themePreset) => {
    seed({ themePreset });
    for (const key of Object.keys(golden)) expect(await open(key), key).toBe(golden[key]);
  });

  it("keeps a stored accent that is not a plain hex out of the page", async () => {
    const hostile = "#7c3aed;background:url(https://evil.example/x)";
    seed({ appearance: look("light", hostile) });
    const html = await open("full?cancelled");
    expect(html).not.toContain("evil.example");
    // The default accent is used instead, which is what the "full" page stores.
    expect(html).toBe(golden["full?cancelled"]);
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
    // Inputs, the cancel notice, tinted checkboxes, the bump box and the pay button.
    expect(html).toContain("border-radius:2px;border:1px solid #2c2c30;font-size:14px;font-family:inherit;background:#161617;color:#f5f5f4;");
    expect(html).toContain("font-size:13px;color:#b45309");
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
    for (const themePreset of ["clean", "midnight", "noir-lime", "sunset", "ocean"]) {
      seed({ themePreset });
      for (const key of Object.keys(golden)) {
        const html = await open(key);
        expect(html, `${themePreset} ${key}`).not.toBe(golden[key]);
        expect(text(html), `${themePreset} ${key}`).toBe(text(golden[key]));
      }
    }
  });

  it("uses the preset's accent, not the page's own", async () => {
    seed({ themePreset: "ocean" });
    const html = await open("accent");
    expect(html).toContain("background:#0284c7;color:#ffffff;");
    expect(html).not.toContain("#0ea5e9");
  });
});
