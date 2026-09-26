import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS, DIRECTORY_HIT, DIRECTORY_MISS, DIRECTORY_SHELL, RICH_HOMEPAGE } from "./sections.fixture";

const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const { classify, run, score } = await import("./listings");

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const PHONE = "+27 41 555 0100";

function input(overrides: Partial<typeof BUSINESS> = {}, homepageHtml: string | null = RICH_HOMEPAGE) {
  const count = vi.fn();
  return {
    business: { ...BUSINESS, ...overrides },
    homepage: homepageHtml === null ? null : { html: homepageHtml, url: "https://www.fixture-plumbing.example.com/" },
    signal: new AbortController().signal,
    count,
  };
}

/** Routes publicFetch by host; unrouted hosts fail like a network error. */
function route(pages: Record<string, () => Response>) {
  publicFetch.mockImplementation(async (url: string) => {
    const host = new URL(url).hostname;
    const page = pages[host];
    if (!page) throw new Error(`ECONNREFUSED ${host}`);
    return page();
  });
}

beforeEach(() => {
  publicFetch.mockReset();
});

describe("listings classify", () => {
  it("found needs the name AND the phone (SA 0 / +27 equivalence, punctuation ignored)", () => {
    expect(classify(DIRECTORY_HIT, BUSINESS.name, PHONE)).toBe("found");
    expect(classify(DIRECTORY_HIT, BUSINESS.name, "041 555 0100")).toBe("found");
    expect(classify(DIRECTORY_HIT.replace("(041) 555-0100", "+27 41 555 0100"), BUSINESS.name, "0415550100")).toBe("found");
  });

  it("name without the phone, or phone without the name, is not_found", () => {
    expect(classify(DIRECTORY_HIT, BUSINESS.name, "041 555 0199")).toBe("not_found");
    expect(classify(DIRECTORY_HIT, "Other Drains", PHONE)).toBe("not_found");
    expect(classify(DIRECTORY_MISS, BUSINESS.name, PHONE)).toBe("not_found");
  });

  it("matches the name on word boundaries, not inside a longer word", () => {
    const page = DIRECTORY_HIT.replace("Fixture Plumbing", "Fixture Plumbingworks");
    expect(classify(page, BUSINESS.name, PHONE)).toBe("not_found");
  });

  it("a non-SA number matches on its digits", () => {
    const page = DIRECTORY_HIT.replace("(041) 555-0100", "+1 (555) 010-0123");
    expect(classify(page, BUSINESS.name, "+1 555 010 0123")).toBe("found");
  });

  it("not fetched, or a client-rendered shell, is unknown", () => {
    expect(classify(null, BUSINESS.name, PHONE)).toBe("unknown");
    expect(classify(DIRECTORY_SHELL, BUSINESS.name, PHONE)).toBe("unknown");
    // Markup is not text: a shell with heavy attributes is still a shell.
    expect(classify(`<div data-state="${"x".repeat(2000)}"></div>`, BUSINESS.name, PHONE)).toBe("unknown");
  });

  it("stays linear on an unclosed-tag flood", () => {
    const t0 = performance.now();
    classify("<a".repeat(300_000), BUSINESS.name, PHONE);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("listings score", () => {
  const c = (status: "found" | "not_found" | "unknown") => ({ directory: "d", url: "u", status });

  it("scores found over readable directories; unknown is not counted", () => {
    expect(score([c("found"), c("not_found"), c("unknown"), c("unknown")])).toEqual({ score: 50, findings: [] });
    expect(score([c("found"), c("unknown")]).score).toBe(100);
    expect(score([c("not_found"), c("unknown")]).score).toBe(0);
  });

  it("never emits listing_missing (no directory gives a trustworthy miss)", () => {
    expect(score([c("not_found"), c("not_found")]).findings).toEqual([]);
  });
});

describe("listings run", () => {
  it("checks the website's Facebook page and four directory searches concurrently, one http each", async () => {
    route({
      "www.facebook.com": () => html(DIRECTORY_HIT),
      "www.bing.com": () => html(DIRECTORY_MISS),
      "www.yep.co.za": () => html(DIRECTORY_SHELL),
      "www.brabys.com": () => html("Forbidden", 403),
    });
    const i = input();
    const out = await run(i);
    expect(out.status).toBe("ok");
    expect(out.score).toBe(50);
    expect(out.findings).toEqual([]);
    expect((out.raw.checks as { directory: string; status: string }[]).map((c) => [c.directory, c.status])).toEqual([
      ["Facebook", "found"],
      ["Bing", "not_found"],
      ["Yellow Pages SA", "unknown"],
      ["Brabys", "unknown"],
      ["Cylex", "unknown"],
    ]);
    expect(i.count).toHaveBeenCalledTimes(5);
    expect(publicFetch.mock.calls[0]![0]).toBe("https://www.facebook.com/FixturePlumbing");
  });

  it("follows a directory redirect through publicFetch, hop by hop", async () => {
    route({
      "www.bing.com": () => new Response(null, { status: 302, headers: { location: "https://cn.bing.com/search?q=x" } }),
      "cn.bing.com": () => html(DIRECTORY_HIT),
    });
    const out = await run(input({}, null));
    expect((out.raw.checks as { directory: string; status: string }[])[1]).toMatchObject({ directory: "Bing", status: "found" });
  });

  it("without a Facebook link on the site, Facebook is unknown and not fetched", async () => {
    route({ "www.bing.com": () => html(DIRECTORY_HIT) });
    const i = input({}, "<html></html>");
    const out = await run(i);
    expect(i.count).toHaveBeenCalledTimes(4);
    expect((out.raw.checks as { status: string; url: string | null }[])[0]).toEqual({ directory: "Facebook", url: null, status: "unknown" });
    expect(publicFetch.mock.calls.map(([u]) => new URL(u as string).hostname)).not.toContain("www.facebook.com");
  });

  it("every directory unknown → unavailable", async () => {
    route({});
    const out = await run(input());
    expect(out.status).toBe("unavailable");
    expect(out.score).toBeNull();
  });

  it("no phone to match on → unavailable, no requests", async () => {
    const out = await run(input({ phone: null }));
    expect(out.status).toBe("unavailable");
    expect(publicFetch).not.toHaveBeenCalled();
  });
});
