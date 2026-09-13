import { afterEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { isPublicPath, loginRedirectUrl, withoutIdentityHeaders } from "./middleware";

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
  it("lets QStash reach the signed crons (the signature is their auth)", () => {
    expect(isPublicPath("/api/cron/gbp-sync")).toBe(true);
    expect(isPublicPath("/api/cron/gbp-retention")).toBe(true);
  });

  it("keeps Sync now and the reviews read behind a session", () => {
    expect(isPublicPath("/api/sub-accounts/sa1/gbp/sync")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/gbp/reviews")).toBe(false);
  });
});

describe("isPublicPath — the GBP public reviews feed", () => {
  it("lets any website reach the feed without a session (the opaque id is the credential)", () => {
    expect(isPublicPath("/api/public/gbp/feed/AbCdEfGhIjKlMnOpQrStUvWxYz012345")).toBe(true);
    expect(isPublicPath("/embed/gbp-reviews.js")).toBe(true);
  });

  it("opens exactly one path segment — nothing under or beside it", () => {
    expect(isPublicPath("/api/public/gbp/feed")).toBe(false);
    expect(isPublicPath("/api/public/gbp/feed/id/extra")).toBe(false);
    expect(isPublicPath("/api/public/gbp/other")).toBe(false);
  });

  it("keeps the widget admin routes behind a session", () => {
    expect(isPublicPath("/api/sub-accounts/sa1/gbp/widget")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/gbp/widget/rotate")).toBe(false);
  });
});

describe("isPublicPath — the WhatsApp settings routes (SP15)", () => {
  it("lets QStash reach the signed quality poll (the signature is its auth)", () => {
    expect(isPublicPath("/api/cron/whatsapp-quality")).toBe(true);
  });

  it("keeps the settings routes behind a session", () => {
    expect(isPublicPath("/api/sub-accounts/sa1/whatsapp/status")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/whatsapp/profile")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/whatsapp/message-links")).toBe(false);
  });
});

describe("isPublicPath — scheduled messages (SP2 T5)", () => {
  it("lets QStash reach the signed fire worker (the signature is its auth)", () => {
    expect(isPublicPath("/api/scheduled-messages/fire")).toBe(true);
  });

  it("keeps booking, listing and cancelling behind a session", () => {
    expect(isPublicPath("/api/scheduled-messages")).toBe(false);
    expect(isPublicPath("/api/scheduled-messages/fire/x")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/scheduled-messages")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/scheduled-messages/m1")).toBe(false);
  });
});

describe("isPublicPath — the /e/[token] reschedule + cancel actions (SP3 widget)", () => {
  it("lets a logged-out visitor's reschedule/cancel POST through — the HMAC token is the credential", () => {
    expect(isPublicPath("/api/events/abc123/reschedule")).toBe(true);
    expect(isPublicPath("/api/events/abc123/cancel")).toBe(true);
    // Token content is opaque to the matcher — dots/hyphens included, same
    // shape hashEventToken/issueEventToken actually produce.
    expect(isPublicPath("/api/events/tok.en-123/reschedule")).toBe(true);
  });

  it("does not widen into the STAFF /by-id/* admin routes, which share the /api/events prefix", () => {
    expect(isPublicPath("/api/events/by-id/evt1/reschedule")).toBe(false);
    expect(isPublicPath("/api/events/by-id/evt1/mark-status")).toBe(false);
    expect(isPublicPath("/api/events/by-id/evt1/assign")).toBe(false);
    expect(isPublicPath("/api/events/by-id/evt1/mark-paid")).toBe(false);
  });

  it("stays closed on the bare collection, a trailing slash, and an extra segment", () => {
    expect(isPublicPath("/api/events")).toBe(false);
    expect(isPublicPath("/api/events/abc123/reschedule/")).toBe(false);
    expect(isPublicPath("/api/events/abc123/reschedule/extra")).toBe(false);
  });
});

describe("withoutIdentityHeaders", () => {
  function requestWithHeaders(entries: Record<string, string>): NextRequest {
    return { headers: new Headers(entries) } as unknown as NextRequest;
  }

  it("strips a caller-forged x-user-uid / x-user-email before forwarding to a public route", () => {
    const forged = requestWithHeaders({
      "x-user-uid": "attacker-uid",
      "x-user-email": "attacker@evil.example",
      "x-forwarded-for": "203.0.113.1",
    });
    const res = withoutIdentityHeaders(forged);
    const overridden = res.headers.get("x-middleware-override-headers") ?? "";
    const overriddenNames = overridden.split(",").map((n) => n.trim());
    expect(overriddenNames).not.toContain("x-user-uid");
    expect(overriddenNames).not.toContain("x-user-email");
    expect(res.headers.get("x-middleware-request-x-user-uid")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-user-email")).toBeNull();
    // A harmless, non-identity header still reaches the route — this isn't
    // a blanket header wipe, only the two identity ones.
    expect(overriddenNames).toContain("x-forwarded-for");
    expect(res.headers.get("x-middleware-request-x-forwarded-for")).toBe(
      "203.0.113.1",
    );
  });

  it("is a no-op when the request never carried the identity headers", () => {
    const clean = requestWithHeaders({ "x-forwarded-for": "203.0.113.1" });
    const res = withoutIdentityHeaders(clean);
    expect(res.headers.get("x-middleware-request-x-user-uid")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-user-email")).toBeNull();
  });
});
