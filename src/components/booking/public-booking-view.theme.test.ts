import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { CHECKOUT_THEMES } from "@/lib/checkout/themes";

/**
 * Style presets on the public booking page, through the real /b and embed
 * server pages: a page with no preset gets no preset markup at all, a known
 * preset restyles it from the preset table alone, and the page's own accent
 * reaches a style attribute only when it is a plain hex colour.
 */

const h = () => import("@/test/booking-harness");
vi.mock("@/lib/firebase/admin", async () => (await h()).bookingMocks.admin());

const { SA, resetBookingHarness, seedPage } = await h();
const { default: PublicBookingPage } = await import("@/app/b/[subAccountId]/[slug]/page");
const { default: EmbedBookingPage } = await import("@/app/(embed)/embed/booking/[subAccountId]/[slug]/page");

const params = (slug: string) => ({ params: Promise.resolve({ subAccountId: SA, slug }) });
const open = async (slug: string) => renderToStaticMarkup((await PublicBookingPage(params(slug))) as ReactElement);
const openEmbed = async (slug: string) => renderToStaticMarkup((await EmbedBookingPage(params(slug))) as ReactElement);
const seed = (slug: string, over: Record<string, unknown> = {}) => seedPage(slug, over as never);

/** The opening tag of the first `<tag …>` in the markup. */
const tag = (html: string, name: string) => html.match(new RegExp(`<${name}[ >][^>]*>|<${name}>`))?.[0];
const LOGO_CHIP = /<span class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl text-white" style="([^"]*)">/;

beforeEach(() => resetBookingHarness());
afterEach(() => vi.useRealTimers());

describe("a booking page with no preset", () => {
  it("adds no style or class to the page shell, heading or logo chip", async () => {
    seed("plain");
    const html = await open("plain");
    expect(tag(html, "main")).toBe('<main class="min-h-screen bg-muted/30 px-4 py-10 text-foreground sm:py-16">');
    expect(tag(html, "article")).toBe('<article class="mx-auto max-w-3xl space-y-8 rounded-3xl border bg-card p-6 shadow-sm sm:p-10">');
    expect(tag(html, "h1")).toBe('<h1 class="text-2xl font-bold tracking-tight sm:text-3xl">');
    expect(html.match(LOGO_CHIP)?.[1]).toBe("background-color:#0F766E");
    expect(tag(await openEmbed("plain"), "main")).toBe('<main class="bg-muted/30 px-3 py-4 text-foreground">');
  });

  it("keeps the page's own accent, and only that, on the logo chip", async () => {
    seed("accent", { accentColor: "#FF5500" });
    expect((await open("accent")).match(LOGO_CHIP)?.[1]).toBe("background-color:#FF5500");
  });

  it("keeps a 3-digit accent too, as the validator stores it", async () => {
    seed("short", { accentColor: "#F50" });
    expect((await open("short")).match(LOGO_CHIP)?.[1]).toBe("background-color:#F50");
  });

  it.each([
    ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
    ["a hex followed by more CSS", "#FF5500;background:url(https://evil.example/x)"],
    ["a CSS function", "url(https://evil.example/x)"],
    ["markup", '"><script src="https://evil.example/x"></script>'],
    ["a colour name", "red"],
    ["a hex with a trailing newline", "#FF5500\n"],
    ["a non-string", ["#FF5500"]],
  ])("ignores a stored accent that is %s, on /b and in the embed", async (_label, accentColor) => {
    seed("clean");
    const [expected, expectedEmbed] = [await open("clean"), await openEmbed("clean")];
    seed("clean", { accentColor });
    for (const [html, plain] of [[await open("clean"), expected], [await openEmbed("clean"), expectedEmbed]]) {
      expect(html).not.toContain("evil.example");
      expect(html).not.toContain("position:fixed");
      expect(html).toBe(plain);
    }
  });

  it("with a preset, falls back to the preset's accent when the stored one is not a hex", async () => {
    seed("both", { themePreset: "noir-lime", accentColor: "red;background:url(https://evil.example/x)" });
    const html = await open("both");
    expect(html).not.toContain("evil.example");
    expect(html.match(LOGO_CHIP)?.[1]).toBe("background-color:#ccff00;color:#0a0a0a");
  });

  it.each([
    ["null", null],
    ["an id this build does not know", "bogus"],
    ["a name every object has", "constructor"],
    ["another name every object has", "__proto__"],
    ["a string shaped like markup", '"><script>alert(1)</script>'],
    ["a string shaped like CSS", "clean;background:url(https://evil.example/x)"],
    ["a number", 42],
    ["an object", { id: "clean" }],
  ])("renders the same when the stored preset is %s", async (_label, themePreset) => {
    seed("absent", { accentColor: "#FF5500" });
    const expected = await open("absent");
    const expectedEmbed = await openEmbed("absent");
    seed("absent", { accentColor: "#FF5500", themePreset });
    expect(await open("absent")).toBe(expected);
    expect(await openEmbed("absent")).toBe(expectedEmbed);
  });
});

describe("a booking page with a preset", () => {
  it("restyles the shell from a dark preset and marks it dark", async () => {
    seed("noir", { themePreset: "noir-lime" });
    const html = await open("noir");
    const main = tag(html, "main")!;
    expect(main).toContain('class="min-h-screen bg-muted/30 px-4 py-10 text-foreground sm:py-16 dark"');
    for (const decl of [
      "--background:#161617",
      "--foreground:#f5f5f4",
      "--card:#0f0f10",
      "--muted:rgba(255,255,255,0.07)",
      "--muted-foreground:#9a9a93",
      "--input:#2c2c30",
      "--ring:#ccff00",
      "--primary:#ccff00",
      "--primary-foreground:#0a0a0a",
      "background:#050505",
    ]) {
      expect(main, decl).toContain(decl);
    }
    expect(tag(html, "article")).toContain('style="border-radius:4px"');
    expect(tag(html, "h1")).toContain('style="text-transform:uppercase;letter-spacing:0.04em;font-weight:800"');
    // The chip takes the preset's button colours: lime with dark text.
    expect(html.match(LOGO_CHIP)?.[1]).toBe("background-color:#ccff00;color:#0a0a0a");
  });

  it("marks a light preset light, not dark", async () => {
    seed("sunset", { themePreset: "sunset" });
    const main = tag(await open("sunset"), "main")!;
    expect(main).toContain('class="min-h-screen bg-muted/30 px-4 py-10 text-foreground sm:py-16 light"');
    expect(main).toContain("background:#fdf6ec");
    expect(main).toContain("--muted:rgba(0,0,0,0.05)");
  });

  it("applies in the embed too, keeping the embed's own shell classes", async () => {
    seed("ocean", { themePreset: "ocean" });
    const main = tag(await openEmbed("ocean"), "main")!;
    expect(main).toContain('class="bg-muted/30 px-3 py-4 text-foreground light"');
    expect(main).toContain("--primary:#027dbc");
  });

  it("lets the page's own accent win over the preset's", async () => {
    seed("both", { themePreset: "noir-lime", accentColor: "#FF5500" });
    const html = await open("both");
    expect(html.match(LOGO_CHIP)?.[1]).toBe("background-color:#FF5500");
    expect(tag(html, "main")).toContain("--primary:#ccff00");
  });

  it("changes nothing but style and the light/dark marker", async () => {
    seed("none");
    const strip = (html: string) => html.replace(/ style="[^"]*"/g, "").replace(/ (dark|light)"/, '"');
    const plain = strip(await open("none"));
    for (const id of Object.keys(CHECKOUT_THEMES)) {
      seed("none", { themePreset: id });
      const html = await open("none");
      expect(tag(html, "main"), id).toContain("style=");
      expect(strip(html), id).toBe(plain);
    }
  });

  it("gives the timezone list readable options in dark mode", async () => {
    seed("tz", { themePreset: "midnight" });
    expect(tag(await open("tz"), "select")).toContain("[&amp;_option]:bg-background [&amp;_option]:text-foreground");
  });
});
