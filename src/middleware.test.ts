import { afterEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { isPublicPath, loginRedirectUrl } from "./middleware";

/**
 * Regression test for the logged-out redirect.
 *
 * Under the standalone server (systemd sets HOSTNAME=127.0.0.1 PORT=4300,
 * behind a cloudflared tunnel) `request.nextUrl` is derived from the server's
 * own bind address rather than the Host header. Every logged-out visit to a
 * protected route on crm.crestahq.com therefore 307'd to
 * `https://localhost:4300/login` — dead for every real user, and invisible to
 * the E2E suite because every spec is authenticated.
 *
 * The fake `nextUrl` mirrors the only NextURL surface this helper uses: the
 * URL properties plus `clone()`, which returns an independent copy.
 */
function requestWith(nextUrl: string): NextRequest {
  const make = (href: string) => {
    const u = new URL(href) as URL & { clone: () => URL };
    u.clone = () => make(u.toString());
    return u;
  };
  return { nextUrl: make(nextUrl) } as unknown as NextRequest;
}

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
});

describe("loginRedirectUrl", () => {
  it("uses the public app origin, not the server's bind address", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    const url = loginRedirectUrl(
      requestWith("http://localhost:4300/agency"),
      "/agency",
    );
    expect(url.origin).toBe("https://crm.crestahq.com");
    expect(url.toString()).toBe(
      "https://crm.crestahq.com/login?redirect=%2Fagency",
    );
    expect(url.toString()).not.toContain("localhost");
  });

  it("keeps the caller's path in ?redirect so login can bounce back", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    const url = loginRedirectUrl(
      requestWith("http://localhost:4300/sa/abc/contacts"),
      "/sa/abc/contacts",
    );
    expect(url.searchParams.get("redirect")).toBe("/sa/abc/contacts");
    expect(url.pathname).toBe("/login");
  });

  it("preserves an existing query string, as the previous clone() did", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    const url = loginRedirectUrl(
      requestWith("http://localhost:4300/agency?invite=xyz"),
      "/agency",
    );
    expect(url.searchParams.get("invite")).toBe("xyz");
    expect(url.searchParams.get("redirect")).toBe("/agency");
  });

  it("falls back to the request origin when the env var is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const url = loginRedirectUrl(
      requestWith("http://localhost:3777/agency"),
      "/agency",
    );
    expect(url.origin).toBe("http://localhost:3777");
  });

  it("falls back rather than throwing when the env var is malformed", () => {
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    const url = loginRedirectUrl(
      requestWith("http://localhost:4300/agency"),
      "/agency",
    );
    expect(url.origin).toBe("http://localhost:4300");
    expect(url.pathname).toBe("/login");
  });
});

describe("isPublicPath — the GBP sync routes", () => {
  it("lets QStash reach the signed cron (the signature is its auth)", () => {
    expect(isPublicPath("/api/cron/gbp-sync")).toBe(true);
  });

  it("keeps Sync now and the reviews read behind a session", () => {
    expect(isPublicPath("/api/sub-accounts/sa1/gbp/sync")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/gbp/reviews")).toBe(false);
  });
});
