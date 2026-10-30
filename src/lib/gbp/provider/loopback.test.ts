import { describe, expect, it } from "vitest";

import {
  APP_LOOPBACK_HOSTNAMES,
  isAppLoopbackUrl,
  isLoopbackHostname,
} from "./loopback.mjs";

/**
 * Two rules, one containing the other. The APP may run the fake only on an
 * exact, short allow-list; the DEPLOY guard blocks a much wider set. Every
 * host the app would accept must be one the guard blocks — otherwise a value
 * could pass the deploy fence and still switch the app into fake mode.
 */

describe("loopback rules", () => {
  it("the app allow-list is exactly 127.0.0.1, localhost and [::1]", () => {
    expect([...APP_LOOPBACK_HOSTNAMES].sort()).toEqual(["127.0.0.1", "[::1]", "localhost"]);
  });

  it("every host the app allows is blocked by the deploy guard", () => {
    for (const host of APP_LOOPBACK_HOSTNAMES) expect(isLoopbackHostname(host)).toBe(true);
  });

  it.each(["http://127.0.0.1:3100", "http://127.1:3100", "HTTP://LOCALHOST", "http://[0:0:0:0:0:0:0:1]/"])(
    "the app accepts %s (WHATWG-normalised onto the list)",
    (url) => expect(isAppLoopbackUrl(url)).toBe(true),
  );

  it.each([
    "http://0.0.0.0:4300",
    "http://[::]:4300",
    "http://127.0.0.2/",
    "http://foo.localhost/",
    "http://localhost./",
    "http://[::ffff:127.0.0.1]/",
    "https://crm.crestahq.com",
    "not a url",
  ])("the app refuses %s", (url) => expect(isAppLoopbackUrl(url)).toBe(false));
});
