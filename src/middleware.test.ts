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
    result: { decodedToken: { uid: string; email?: string; agencyId?: unknown; status?: unknown } },
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
import { safeRedirect } from "@/lib/auth/safe-redirect";

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
    expect(url.searchParams.get("redirect")).toBe("/agency?invite=xyz");
  });

  it("carries a share link's ?token through login in ?redirect", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    const url = loginRedirectUrl(
      requestWith("http://localhost:4300/agency/snapshots/import?token=abc"),
      "/agency/snapshots/import",
    );
    expect(url.origin).toBe("https://crm.crestahq.com");
    expect(url.pathname).toBe("/login");
    const redirect = url.searchParams.get("redirect");
    expect(redirect).toBe("/agency/snapshots/import?token=abc");
    expect(url.searchParams.has("token")).toBe(false);
    // And the login form lands the visitor back on exactly that.
    expect(safeRedirect(redirect)).toBe("/agency/snapshots/import?token=abc");
  });

  it("still lets the login form refuse a redirect that leaves the origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    // A protocol-relative path is the one shape the middleware itself can
    // emit; the consumer must refuse it, query and all.
    const url = loginRedirectUrl(
      requestWith("http://localhost:4300//evil.example/x?token=abc"),
      "//evil.example/x",
    );
    expect(url.searchParams.get("redirect")).toBe("//evil.example/x?token=abc");
    expect(safeRedirect(url.searchParams.get("redirect"))).toBe("/dashboard");
    expect(safeRedirect("https://evil.example/agency?token=abc")).toBe("/dashboard");
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

describe("isPublicPath — the gitpage build-settled callback", () => {
  it("lets gitpage reach the callback without a session (the HMAC is its auth)", () => {
    expect(isPublicPath("/api/webhooks/gitpage/build-settled")).toBe(true);
  });

  it("opens exactly that path — nothing under or beside it", () => {
    expect(isPublicPath("/api/webhooks/gitpage")).toBe(false);
    expect(isPublicPath("/api/webhooks/gitpage/build-settled/extra")).toBe(false);
    expect(isPublicPath("/api/webhooks/gitpage/other")).toBe(false);
  });

  it("keeps the session-authed website routes behind a session", () => {
    expect(isPublicPath("/api/sub-accounts/sa1/website/concepts")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/website/site1")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/website/site1/poll-now")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/website/site1/domain")).toBe(false);
  });
});

describe("isPublicPath — snapshot share links", () => {
  it("keeps the import page and its API behind a session (the token alone is not a login)", () => {
    expect(isPublicPath("/agency/snapshots/import")).toBe(false);
    expect(isPublicPath("/api/agency/snapshots/import")).toBe(false);
    expect(isPublicPath("/api/agency/snapshots/import-file")).toBe(false);
  });

  it("opens the share page and its file download to a visitor with no session", () => {
    expect(isPublicPath("/s/snapshot/AbC-12_x")).toBe(true);
    expect(isPublicPath("/api/public/snapshots/AbC-12_x")).toBe(true);
  });

  it("opens exactly one segment — nothing under or beside them", () => {
    expect(isPublicPath("/s/snapshot")).toBe(false);
    expect(isPublicPath("/s/snapshot/tok/extra")).toBe(false);
    expect(isPublicPath("/s/other/tok")).toBe(false);
    expect(isPublicPath("/api/public/snapshots")).toBe(false);
    expect(isPublicPath("/api/public/snapshots/tok/extra")).toBe(false);
  });
});

describe("isPublicPath — Paystack payment links", () => {
  it("opens the pay page to a payer with no session", () => {
    expect(isPublicPath("/pay/link/abc.def.123")).toBe(true);
  });

  it("keeps the operator's create/deactivate API behind a session", () => {
    expect(isPublicPath("/api/sub-accounts/sa1/payment-links")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/payment-links/l1")).toBe(false);
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

describe("isPublicPath — the prospect report PDF (R5)", () => {
  it("opens /report/{token}/pdf and nothing else under the token", () => {
    expect(isPublicPath("/report/AbC-12_x/pdf")).toBe(true);
    expect(isPublicPath("/report/AbC-12_x/pdfx")).toBe(false);
    expect(isPublicPath("/report/AbC-12_x/pdf/extra")).toBe(false);
    expect(isPublicPath("/report/AbC-12_x/other")).toBe(false);
    expect(isPublicPath("/report/pdf")).toBe(true); // a one-segment token path, as before
    expect(isPublicPath("/report//pdf")).toBe(false);
  });
});

describe("isPublicPath — the WhatsApp settings routes (SP15)", () => {
  it("lets QStash reach the signed quality poll (the signature is its auth)", () => {
    expect(isPublicPath("/api/cron/whatsapp-quality")).toBe(true);
  });

  it("lets QStash reach the signed staging cleanup, and keeps upload-url behind a session", () => {
    expect(isPublicPath("/api/cron/whatsapp-staging-cleanup")).toBe(true);
    expect(isPublicPath("/api/cron/ai-models")).toBe(true);
    expect(isPublicPath("/api/cron/daily-housekeeping")).toBe(true);
    expect(isPublicPath("/api/comms/whatsapp/upload-url")).toBe(false);
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

/**
 * `x-agency-id` seeds the dashboard's server-rendered branding (see
 * src/lib/server/agency-branding.ts). It must come ONLY from the verified
 * token's custom claims — a caller-sent value is dropped on every path.
 */
describe("middleware() — x-agency-id comes only from the verified token", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "test-key";
    process.env.FIREBASE_ADMIN_PROJECT_ID = "test-project";
    capturedOptions = null;
  });

  it("drops a forged x-agency-id on a public path (invalid token and error)", async () => {
    const req = fullRequest("/api/forms/f1", { "x-agency-id": "victim-agency" });
    await middleware(req);
    for (const handler of [capturedOptions!.handleInvalidToken, capturedOptions!.handleError]) {
      const res = (await handler()) as Response;
      expect(overriddenHeaderNames(res).length).toBeGreaterThan(0);
      expect(overriddenHeaderNames(res)).not.toContain("x-agency-id");
      expect(res.headers.get("x-middleware-request-x-agency-id")).toBeNull();
    }
  });

  it("drops a forged x-agency-id on static-image and Firebase-unconfigured paths", async () => {
    const img = (await middleware(
      fullRequest("/logo.svg", { "x-agency-id": "victim-agency" }),
    )) as Response;
    expect(overriddenHeaderNames(img)).not.toContain("x-agency-id");
    expect(img.headers.get("x-middleware-request-x-agency-id")).toBeNull();

    delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    const pub = (await middleware(
      fullRequest("/api/forms/f1", { "x-agency-id": "victim-agency" }),
    )) as Response;
    expect(overriddenHeaderNames(pub)).not.toContain("x-agency-id");
    expect(pub.headers.get("x-middleware-request-x-agency-id")).toBeNull();
  });

  it("a valid session overwrites a forged x-agency-id with the token's agencyId claim", async () => {
    const req = fullRequest("/agency", { "x-agency-id": "victim-agency" });
    await middleware(req);
    const res = (await capturedOptions!.handleValidToken(
      { decodedToken: { uid: "u1", agencyId: "real-agency", status: "active" } },
      new Headers(req.headers),
    )) as Response;
    expect(res.headers.get("x-middleware-request-x-agency-id")).toBe("real-agency");
  });

  it("a token whose status claim is not active never carries x-agency-id", async () => {
    const req = fullRequest("/agency", { "x-agency-id": "victim-agency" });
    await middleware(req);
    for (const status of ["removed", "disabled", undefined, true]) {
      const res = (await capturedOptions!.handleValidToken(
        { decodedToken: { uid: "u1", agencyId: "real-agency", status } },
        new Headers(req.headers),
      )) as Response;
      expect(overriddenHeaderNames(res)).not.toContain("x-agency-id");
      expect(res.headers.get("x-middleware-request-x-agency-id")).toBeNull();
    }
  });

  it("a valid session with no agencyId claim drops a forged x-agency-id", async () => {
    const req = fullRequest("/agency", { "x-agency-id": "victim-agency" });
    await middleware(req);
    for (const agencyId of [undefined, "", 42]) {
      const res = (await capturedOptions!.handleValidToken(
        { decodedToken: { uid: "u1", agencyId, status: "active" } },
        new Headers(req.headers),
      )) as Response;
      expect(overriddenHeaderNames(res)).not.toContain("x-agency-id");
      expect(res.headers.get("x-middleware-request-x-agency-id")).toBeNull();
    }
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

describe("middleware() — identity headers are never trusted from the caller (S11)", () => {
  it("keeps the dev-only wipe route behind a session", () => {
    expect(isPublicPath("/api/dev-only/danger-wipe-everything")).toBe(false);
  });

  it("runs on image-extension paths, so a forged uid there is stripped too", async () => {
    const { config } = await import("./middleware");
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    expect(pattern.test("/api/sub-accounts/sa1/photo.png")).toBe(true);
    expect(pattern.test("/logo.svg")).toBe(true);

    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "test-key";
    process.env.FIREBASE_ADMIN_PROJECT_ID = "test-project";
    capturedOptions = null;
    const res = (await middleware(
      fullRequest("/api/sub-accounts/sa1/photo.png", { "x-user-uid": "attacker-uid" }),
    )) as Response;
    // Static images skip session verification entirely — they are only
    // stripped, never authenticated or redirected.
    expect(capturedOptions).toBeNull();
    expect(overriddenHeaderNames(res).length).toBeGreaterThan(0);
    expect(overriddenHeaderNames(res)).not.toContain("x-user-uid");
    expect(res.headers.get("x-middleware-request-x-user-uid")).toBeNull();
  });

  it("fails closed when Firebase is not configured: strips identity, denies protected paths", async () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    delete process.env.FIREBASE_ADMIN_PROJECT_ID;

    const pub = (await middleware(
      fullRequest("/api/forms/f1", { "x-user-uid": "attacker-uid" }),
    )) as Response;
    expect(overriddenHeaderNames(pub).length).toBeGreaterThan(0);
    expect(overriddenHeaderNames(pub)).not.toContain("x-user-uid");
    expect(pub.headers.get("x-middleware-request-x-user-uid")).toBeNull();

    const prot = (await middleware(
      fullRequest("/api/agency/settings", { "x-user-uid": "attacker-uid" }),
    )) as Response;
    expect(prot.status).toBe(307);
    expect(new URL(prot.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("isPublicPath — the MCP route", () => {
  it("lets a bearer-key agent reach /api/mcp without a session, and nothing that merely shares the prefix", () => {
    expect(isPublicPath("/api/mcp")).toBe(true);
    expect(isPublicPath("/api/mcpx")).toBe(false);
  });
});

describe("isPublicPath — prospect report share links + worker", () => {
  it("opens the share page, its JSON and the QStash worker without a session", () => {
    expect(isPublicPath("/report/AbC-12_x")).toBe(true);
    expect(isPublicPath("/api/public/prospecting/report/AbC-12_x")).toBe(true);
    expect(isPublicPath("/api/automations/prospecting/report")).toBe(true);
  });

  it("opens the preview image (R4) and the PDF (R5) under a token, exactly", () => {
    expect(isPublicPath("/report/AbC-12_x/opengraph-image")).toBe(true);
    expect(isPublicPath("/report/AbC-12_x/pdf")).toBe(true);
    for (const p of [
      "/report/tok/other",
      "/report/tok/pdf/x",
      "/report/tok/opengraph-image/x",
      "/report/tok/opengraph-imagex",
      "/report/tok/pdfx",
      "/report/tok/x/pdf",
      "/report//pdf",
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("opens exactly one segment — nothing under or beside them", () => {
    expect(isPublicPath("/report")).toBe(false);
    expect(isPublicPath("/report/tok/extra")).toBe(false);
    expect(isPublicPath("/reports/tok")).toBe(false);
    expect(isPublicPath("/api/public/prospecting")).toBe(false);
    expect(isPublicPath("/api/public/prospecting/report/tok/extra")).toBe(false);
    expect(isPublicPath("/api/automations/prospecting/report/x")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/prospecting/reports")).toBe(false);
  });
});

describe("isPublicPath — the ApexGEO poll worker (Prospecting PR 3)", () => {
  it("opens the exact path the report worker queues polls to, and nothing under it", async () => {
    const { APEXGEO_POLL_PATH } = await import("@/lib/prospecting/apexgeo-report");
    expect(isPublicPath(APEXGEO_POLL_PATH)).toBe(true);
    expect(isPublicPath(`${APEXGEO_POLL_PATH}/x`)).toBe(false);
  });

  it("keeps the key routes behind a session", () => {
    expect(isPublicPath("/api/sub-accounts/sa1/apexgeo-connection")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/apexgeo-connection/test")).toBe(false);
  });
});

describe("isPublicPath — the prospect report announce sweep", () => {
  it("opens the exact path the QStash schedule calls, and nothing under it", () => {
    expect(isPublicPath("/api/automations/prospecting/announce-sweep")).toBe(true);
    expect(isPublicPath("/api/automations/prospecting/announce-sweep/x")).toBe(false);
    expect(isPublicPath("/api/automations/prospecting/mystery-shop")).toBe(true);
    expect(isPublicPath("/api/automations/prospecting/mystery-shop/x")).toBe(false);
    expect(isPublicPath("/api/sub-accounts/sa1/prospecting/mystery-shop")).toBe(false);
    expect(isPublicPath("/api/automations/prospecting/mystery-shop-form")).toBe(true);
    expect(isPublicPath("/api/automations/prospecting/mystery-shop-form/x")).toBe(false);
    expect(isPublicPath("/api/automations/prospecting/mystery-shop-formx")).toBe(false);
  });
});
