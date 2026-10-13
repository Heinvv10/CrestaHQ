import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolvedAppUrl } from "./app-url";

/**
 * resolvedAppUrl is what gets baked into a built site and handed to gitpage
 * as the callback address, so it must be the origin that ANSWERS: an apex
 * that redirects to www breaks a cross-origin form POST at its preflight.
 */

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
const fetchMock = vi.fn();

/** A response as `fetch` hands it back after following redirects to `url`. */
const landedOn = (url: string) => Object.defineProperty(new Response(null), "url", { value: url });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
});

describe("resolvedAppUrl", () => {
  it("returns the origin the app URL redirects to (apex → www)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test/";
    fetchMock.mockResolvedValue(landedOn("https://www.crm.example.test/widget.js"));
    expect(await resolvedAppUrl()).toBe("https://www.crm.example.test");
    // The probe is our own static file, followed natively: this URL is ours.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://crm.example.test/widget.js");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "follow" });
  });

  it("returns the app URL itself when nothing redirects", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test";
    fetchMock.mockResolvedValue(landedOn("https://crm.example.test/widget.js"));
    expect(await resolvedAppUrl()).toBe("https://crm.example.test");
  });

  it("falls back to the app URL when the probe fails or times out", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test";
    fetchMock.mockRejectedValue(new Error("The operation was aborted due to timeout"));
    expect(await resolvedAppUrl()).toBe("https://crm.example.test");
  });

  it("falls back to the app URL when the redirect leaves https", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.test";
    fetchMock.mockResolvedValue(landedOn("http://crm.example.test/widget.js"));
    expect(await resolvedAppUrl()).toBe("https://crm.example.test");
  });

  it.each([
    ["unset", ""],
    ["plain http", "http://crm.example.test"],
    ["a loopback address", "http://127.0.0.1:3100"],
    ["a URL with a path", "https://example.test/crm"],
  ])("is null, without probing anything, when the app URL is %s", async (_label, value) => {
    process.env.NEXT_PUBLIC_APP_URL = value;
    expect(await resolvedAppUrl()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
