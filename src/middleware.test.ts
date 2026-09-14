import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * `middleware()` (the default export) delegates its actual auth decision to
 * `authMiddleware` from next-firebase-auth-edge — it doesn't call
 * `handleInvalidToken`/`handleError` itself, the library does, after trying
 * to verify the session cookie. Mocking the library lets these tests run
 * `middleware()` for real (proving the wiring, not just the helper function
 * in isolation) while capturing the `options` object so each handler can be
 * invoked directly and its return value inspected — same idea as spying on
 * a callback without needing the library's own cookie-verification internals.
 */
type MiddlewareOptions = {
  handleValidToken: (
    result: { decodedToken: { uid: string; email?: string } },
    headers: Headers,
  ) => Promise<unknown>;
  handleInvalidToken: () => Promise<unknown>;
  handleError: () => Promise<unknown>;
};
let capturedOptions: MiddlewareOptions | null = null;
vi.mock("next-firebase-auth-edge/lib/next/middleware", () => ({
  authMiddleware: async (_request: NextRequest, options: MiddlewareOptions) => {
    capturedOptions = options;
    const { NextResponse } = await import("next/server");
    return NextResponse.next();
  },
}));

import middleware, { isPublicPath, loginRedirectUrl, withoutIdentityHeaders } from "./middleware";

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

/**
 * A full-enough NextRequest for `middleware()` itself: `nextUrl` (path +
 * clone, as above, plus a host-bearing `url` string funnelSubdomainFrom
 * reads through `headers.get("host")` — not `nextUrl` — so a plain
 * `headers` map covers it) and real `Headers` so `.get()`/`.set()` behave
 * exactly as the library and `withoutIdentityHeaders` expect.
 */
function fullRequest(pathname: string, headers: Record<string, string> = {}): NextRequest {
  const make = (href: string) => {
    const u = new URL(href) as URL & { clone: () => URL };
    u.clone = () => make(u.toString());
    return u;
  };
  return {
    nextUrl: make(`https://app.example.test${pathname}`),
    headers: new Headers({ host: "app.example.test", ...headers }),
    url: `https://app.example.test${pathname}`,
  } as unknown as NextRequest;
}

const ORIGINAL_FIREBASE_ENV = {
  key: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  project: process.env.FIREBASE_ADMIN_PROJECT_ID,
};
afterEach(() => {
  if (ORIGINAL_FIREBASE_ENV.key === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  else process.env.NEXT_PUBLIC_FIREBASE_API_KEY = ORIGINAL_FIREBASE_ENV.key;
  if (ORIGINAL_FIREBASE_ENV.project === undefined) delete process.env.FIREBASE_ADMIN_PROJECT_ID;
  else process.env.FIREBASE_ADMIN_PROJECT_ID = ORIGINAL_FIREBASE_ENV.project;
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

/**
 * `x-middleware-request-x-user-uid` being absent is NOT proof of stripping
 * on its own — a response with NO request override at all (the exact
 * pre-fix bug: `NextResponse.next()` with no args) also has it absent,
 * because Next only emits `x-middleware-request-*` overrides when
 * `x-middleware-override-headers` names that header. So the discriminating
 * check is: an override DID happen (proving `withoutIdentityHeaders` ran,
 * not that nothing ran), and the identity headers are not among the
 * overridden ones.
 */
function overriddenHeaderNames(res: Response): string[] {
  const raw = res.headers.get("x-middleware-override-headers");
  return raw ? raw.split(",").map((n) => n.trim()) : [];
}

describe("middleware() end to end — the actual wiring, not just the helper", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "test-key";
    process.env.FIREBASE_ADMIN_PROJECT_ID = "test-project";
    capturedOptions = null;
  });

  it("strips a forged x-user-uid on handleInvalidToken for a public path (/api/forms, for DELETE /api/forms/[id])", async () => {
    const req = fullRequest("/api/forms/f1", {
      "x-user-uid": "attacker-uid",
      "x-user-email": "attacker@evil.example",
    });
    await middleware(req);
    expect(capturedOptions).not.toBeNull();

    const res = (await capturedOptions!.handleInvalidToken()) as Response;
    const overridden = overriddenHeaderNames(res);
    // Proves withoutIdentityHeaders actually ran (an override DID happen —
    // `host`, at least, is always in the list) rather than merely proving
    // nothing was overridden at all, which a `NextResponse.next()` no-args
    // regression would also (misleadingly) satisfy.
    expect(overridden.length).toBeGreaterThan(0);
    expect(overridden).not.toContain("x-user-uid");
    expect(overridden).not.toContain("x-user-email");
    expect(res.headers.get("x-middleware-request-x-user-uid")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-user-email")).toBeNull();
  });

  it("strips a forged x-user-uid on handleError for the same public path", async () => {
    const req = fullRequest("/api/forms/f1", { "x-user-uid": "attacker-uid" });
    await middleware(req);
    expect(capturedOptions).not.toBeNull();

    const res = (await capturedOptions!.handleError()) as Response;
    const overridden = overriddenHeaderNames(res);
    expect(overridden.length).toBeGreaterThan(0);
    expect(overridden).not.toContain("x-user-uid");
    expect(res.headers.get("x-middleware-request-x-user-uid")).toBeNull();
  });

  it("a valid session overwrites a forged uid with the verified token's uid, not the caller's", async () => {
    const req = fullRequest("/api/forms/f1", {
      "x-user-uid": "attacker-uid",
      "x-user-email": "attacker@evil.example",
    });
    await middleware(req);
    expect(capturedOptions).not.toBeNull();

    const res = (await capturedOptions!.handleValidToken(
      { decodedToken: { uid: "real-verified-uid", email: "real@example.com" } },
      new Headers(req.headers),
    )) as Response;
    expect(res.headers.get("x-middleware-request-x-user-uid")).toBe(
      "real-verified-uid",
    );
    expect(res.headers.get("x-middleware-request-x-user-email")).toBe(
      "real@example.com",
    );
  });
});

describe("isPublicPath — review-request click link and reminders (SP5 d2)", () => {
  it("lets a customer's click reach /rr/{token} (the signed token is the credential)", () => {
    expect(isPublicPath("/rr/sa1.req1.abcdef0123")).toBe(true);
  });

  it("opens exactly one segment under /rr — nothing beside or under it", () => {
    expect(isPublicPath("/rr")).toBe(false);
    expect(isPublicPath("/rr/a/b")).toBe(false);
    expect(isPublicPath("/rrx/a")).toBe(false);
  });

  it("lets QStash reach the signed reminder worker (the signature is its auth)", () => {
    expect(isPublicPath("/api/cron/review-reminder")).toBe(true);
  });

  it("keeps the Requests list and the config behind a session", () => {
    expect(isPublicPath("/api/sub-accounts/sa1/reputation/requests")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/google-review")).toBe(false);
  });
});
