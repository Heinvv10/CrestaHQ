import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/landing/resolve-brand", () => ({
  resolveCustomBrand: vi.fn(async () => ({ primaryDomain: "crestahq.com" })),
}));

describe("home page metadata", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is noindex,follow when the app runs off the brand's primary domain", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.crestahq.com");
    const { generateMetadata } = await import("./page");
    expect(await generateMetadata()).toEqual({ robots: { index: false, follow: true } });
  });

  it("stays indexable when the app is the primary domain", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crestahq.com");
    const { generateMetadata } = await import("./page");
    expect(await generateMetadata()).toEqual({});
  });
});
