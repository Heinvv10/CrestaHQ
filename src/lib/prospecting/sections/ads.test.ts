import { describe, expect, it } from "vitest";
import { run } from "./ads";
import { BUSINESS } from "./sections.fixture";

const input = (website: string | null) => ({
  business: { ...BUSINESS, website },
  homepage: null,
  signal: new AbortController().signal,
  count: () => undefined,
});

describe("ads run", () => {
  it("is always unavailable with manual links, never a guessed no_ads_running", async () => {
    const out = await run(input("https://www.fixture-plumbing.example.com/"));
    expect(out).toMatchObject({ status: "unavailable", score: null, findings: [] });
    expect(out.raw).toEqual({
      metaAdLibraryUrl:
        "https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ZA&q=Fixture%20Plumbing%20(Pty)%20Ltd",
      googleAdsTransparencyUrl: "https://adstransparency.google.com/?region=ZA&domain=fixture-plumbing.example.com",
    });
  });

  it("omits the Google link without a usable website", async () => {
    expect((await run(input(null))).raw.googleAdsTransparencyUrl).toBeNull();
    expect((await run(input("not a url"))).raw.googleAdsTransparencyUrl).toBeNull();
  });
});
