import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authMiddleware } from "next-firebase-auth-edge/lib/next/middleware";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/signup",
  "/terms",
  "/privacy",
  "/security",
  "/api-webhooks",
  "/about",
  "/thank-you",
  // Affiliate direct "Buy now" link (/buy?ref=CODE). Sets the referral
  // cookie client-side then bounces to Stripe checkout. Public — no session.
  "/buy",
  // Secret webinar-only founders landing. Unlinked + noindex (page
  // metadata); the URL is only shared during webinars. Public — no session.
  "/founderx",
  // On-brand webinar registration landing (custom form posts to webinar1.dev).
  // Unlinked + noindex (page metadata); shared via ads/emails/socials. Public.
  "/webinar",
  // Public docs (e.g. /docs/updating — the "keeping your app up to date"
  // guide linked from /thank-you and shareable as a stable URL).
  "/docs",
  "/f",
  "/api/forms",
  "/api/auth/signup",
  // Workflow Builder step worker — QStash callback, signature-verified inside
  // the route.
  "/api/workflows/step",
  "/api/broadcasts/email/step",
  // Broadcast fan-out pages — QStash callback, signature-verified in the route.
  "/api/broadcasts/email/fanout",
  "/api/checkout",
  "/api/cron/gitpage-heartbeat",
  // Daily sweep for the public API's TTL'd collections (apiRequestLogs,
  // apiIdempotency, webhookEvents). Replaces native Firestore TTL so the
  // buyer doesn't need to click into the Firebase console — QStash is
  // already part of their onboarding. Signature-verified inside the route.
  "/api/cron/api-cleanup",
  // Daily recurring-invoice sweep. Public like the other cron routes — the
  // QStash signature is the authentication.
  "/api/cron/recurring-invoices",
  "/api/cron/email-sync",
  // 6-hourly Google Business Profile review sync. Public like the other cron
  // routes — the QStash signature, verified inside the route, is the auth.
  "/api/cron/gbp-sync",
  // Daily GBP review-cache retention (always on). Same auth: the signature.
  "/api/cron/gbp-retention",
  // Hourly WhatsApp Cloud quality-rating poll (SP15). Same auth: the signature.
  "/api/cron/whatsapp-quality",
  // Daily sweep of abandoned WhatsApp composer uploads. Same auth: the signature.
  "/api/cron/whatsapp-staging-cleanup",
  // Daily OpenRouter model-list refresh. Same auth: the signature.
  "/api/cron/ai-models",
  // Review-request reminders (SP5 d2) — one QStash message per scheduled
  // reminder. Same auth: the signature, bound to this route's URL.
  "/api/cron/review-reminder",
  // Quiet-hours release — one QStash message per automated SMS/WhatsApp held
  // for the workspace's quiet hours. Same auth: the signature, bound to the URL.
  "/api/comms/quiet-hours/release",
  // Hourly Inbox Follow-up Watchdog sweep (Labs). QStash-scheduled;
  // signature-verified inside the route.
  "/api/agents/watchdog/step",
  "/api/landing/metrics",
  "/api/landing/recent-purchases",
  // Live-visitors heartbeat ping for the agency dashboard's world map.
  // Public POST from every landing-page browser every ~5s. Validation
  // + best-effort failure handling inside the route — never breaks
  // the landing experience.
  "/api/landing/heartbeat",
  "/api/webhooks/twilio",
  "/api/webhooks/stripe",
  // Client Billing on Paystack. Public like the Stripe endpoint — Paystack
  // signs every event with the account secret key, and that signature is the
  // authentication.
  "/api/webhooks/paystack",
  // Meta (Facebook Messenger + Instagram DM) webhook — BETA. Public from the
  // Meta cloud: GET is the verify-token handshake, POST carries message events.
  // Security: X-Hub-Signature-256 (HMAC of the raw body with the app secret)
  // verified inside the route; per-sub-account routing by Page / IG id.
  "/api/webhooks/meta",
  // Meta WhatsApp Cloud API webhook — the `cloud` arm of the WhatsApp provider
  // seam. GET is the verify-token handshake, POST carries inbound messages and
  // delivery receipts. Security is the SAME X-Hub-Signature-256 check the
  // Messenger/IG webhook uses (one Meta app, one app secret); routing is by
  // metadata.phone_number_id. Kept a separate route because the payload shape
  // and routing key differ. See docs/WHATSAPP_PROVIDER_PLAN.md.
  "/api/webhooks/whatsapp-cloud",
  // Post-payment GitHub-invite endpoint. Public POST from the buyer's
  // browser on the /thank-you page. Security: 256-bit claim token in
  // the request body must hash-match the value stored on
  // purchases/{sessionId} by the Stripe webhook; 3-attempt permanent
  // lock per session on top.
  "/api/github",
  // Vapi voice-agent webhooks — public from the Vapi cloud. Security:
  //   - `?s=${VAPI_WEBHOOK_SECRET}` query param, compared in constant time
  //     inside each route (lib/comms/voice/webhook-auth.ts). Our provisioning
  //     code bakes it into each assistant's server URL.
  //   - ONE deployment-wide secret: the [subAccountId] path param is routing
  //     only, so a leaked secret can impersonate Vapi for EVERY sub-account.
  "/api/webhooks/vapi",
  // Web Chat widget — public from-the-browser API. Security:
  //  - Origin header validated against per-sub-account allowedDomains
  //  - In-memory per-IP + per-session rate limits
  //  - Anonymous sessions; identity only captured via [[capture …]] marker
  "/api/web-chat",
  // Embed pages — the chat widget iframe target. Public; the bot
  // can't send messages without passing the /api/web-chat/* origin check.
  "/embed",
  // Widget loader JS — public static file served from /public.
  "/widget.js",
  // Booking widget loader JS — public static file served from /public.
  "/booking-embed.js",
  // PWA — the manifest is fetched by the browser without credentials on
  // every page (including /login), and the service worker script must be
  // publicly fetchable for registration. Both are harmless to expose:
  // the manifest is branding metadata, sw.js is push-display code only.
  "/manifest.webmanifest",
  "/sw.js",
  // App-icon serving route — the OS/browser fetches manifest icons and the
  // apple-touch icon without credentials. Serves the owner-uploaded icon
  // or 302s to the static fallback; read-only, nothing sensitive.
  "/api/pwa",
  "/u",
  "/api/u",
  // Public quote pages — recipient-facing /q/[token] view (server-rendered)
  // and the accept/decline endpoint. Both gated by HMAC-signed token
  // verification inside the route; no session needed.
  "/q",
  "/api/quotes",
  // Public review + feedback page — customer-facing /r/[token] view and its
  // submit endpoint. Both gated by HMAC-signed token verification plus a
  // `contact.reviewTokenHash` match inside the route; no session needed.
  "/r",
  "/api/reviews",
  // Public booking pages — /b/[saId]/[slug] hosted slot picker, plus the
  // availability + book POST endpoints. Security:
  //  - Page reads only return slots when `status === "published"`
  //  - Per-IP rate limit on availability + book POSTs
  //  - Server-side transactional re-verify at book time so a stale
  //    visitor can't double-book a slot
  "/b",
  "/api/booking",
  // Public funnel pages — /fn/[saId]/[slug] pitch page + its thanks page
  // (Labs experiment). Read-only content; no API surface of its own, since
  // the CTA hands off to the existing /co checkout. Both 404 unless the
  // funnel is published AND the Labs gate is on, so withdrawing the
  // experiment takes every funnel offline without deleting anything.
  "/fn",
  // Vanity-subdomain resolver — the internal target of the host rewrite
  // above. Same public/published gating as /fn, applied inside the route.
  "/fnh",
  // Public checkout pages — /co/[saId]/[slug] offer page + its thanks page,
  // plus the session-create POST. Buyers aren't logged in, so there's no
  // session to check. Security:
  //  - Page + session route both 404 unless `status === "published"` AND the
  //    agency Payments gate is on
  //  - Prices, currency, and the eligible bump set are re-read from Firestore
  //    server-side; the request body only says WHICH bumps were ticked
  //  - Per-IP rate limit on the session POST (contacts + orders are created)
  //  - Card details never touch this app — Stripe's hosted page owns them
  "/co",
  "/api/co",
  // Public event-management page (/e/[token]) + cancel/reschedule
  // endpoints. All gated by HMAC-token + hash match against the stored
  // `event.publicTokenHash`. Reschedule rotates the token so any
  // previously-mailed link invalidates cleanly.
  "/e",
  // Booking reminder + payment-auto-expire QStash callbacks. Security:
  // Upstash-Signature header verification inside the route.
  "/api/events/reminder",
  "/api/events/payment",
  "/setup.html",
  // SEO conventions — Next.js serves these as virtual routes from
  // src/app/robots.ts and src/app/sitemap.ts respectively. Both must
  // reach crawlers unauthenticated.
  "/robots.txt",
  "/sitemap.xml",
  // Affiliate program — own session model (magic-link HMAC cookie), not
  // Firebase Auth. Auth checks happen inside each route/page.
  "/affiliate",
  "/api/affiliate",
  // Community + Courses (Skool-style) member surface — own session model
  // (magic-link HMAC cookie scoped to the sub-account), NOT Firebase Auth.
  // The agency gate + member-session checks happen inside each route/page;
  // a member session can never resolve into the staff `/sa/*` surface.
  "/c",
  "/api/community",
  // Client Billing v1 — public checkout entry + post-checkout status page.
  // The HMAC-signed token in the URL is the credential (verified inside the
  // route against billing.checkoutTokenHash, quote-link model); a valid
  // link 303s into Stripe Checkout.
  "/pay",
  // Public REST API (v1+). Auth happens INSIDE each route via Bearer-token
  // verification (lib/api/auth.ts), not via session cookie. Sub-account-
  // scoped keys; tenancy enforced in code (Admin SDK writes bypass
  // Firestore rules). Adding the prefix here means the Firebase-edge
  // middleware doesn't try to redirect API-key callers to /login.
  "/api/v1",
  // Outbound-webhook delivery worker. QStash callback only — signature-
  // verified inside the route via `verifyQStashSignature`. Mirrors the
  // existing /api/broadcasts/email/step + /api/workflows/step paths.
  "/api/webhooks-out",
];

/**
 * Dynamic public paths — patterns that contain a path param. These are
 * QStash-callback / webhook endpoints whose security comes from signature
 * verification inside the route, not from session auth.
 */
const PUBLIC_PATH_PATTERNS: RegExp[] = [
  // Bulk outbound-call step — QStash callback, signature-verified inside
  // the route (same security model as /api/broadcasts/email/step).
  /^\/api\/comms\/voice\/campaign\/step$/,
  // Bulk outbound-call fan-out pages — same model as the step above.
  /^\/api\/comms\/voice\/campaign\/fanout$/,
  // 3-day post-purchase Gitpage bonus reminder — QStash callback,
  // signature-verified inside the route.
  /^\/api\/gitpage-reminder\/step$/,
  // gitpage build poll: /api/sub-accounts/{id}/website/{siteId}/poll
  /^\/api\/sub-accounts\/[^/]+\/website\/[^/]+\/poll$/,
  // Social Planner publish callback — QStash callback, signature-verified
  // inside the route (same security model as /api/workflows/step).
  /^\/api\/social\/publish\/step$/,
  // GHL migration drain — QStash callback, signature-verified in the route.
  /^\/api\/import\/ghl\/step$/,
  // Scheduled conversation message worker (SP2 T5) — QStash callback,
  // signature-verified inside the route (same model as /api/workflows/step).
  /^\/api\/scheduled-messages\/fire$/,
  // WhatsApp template approval poll: /api/sub-accounts/{id}/whatsapp-templates/poll
  // QStash callback, signature-verified inside the route.
  /^\/api\/sub-accounts\/[^/]+\/whatsapp-templates\/poll$/,
  // Per-sub-account Stripe webhook: /api/webhooks/stripe/sa/{subAccountId}
  // (Payments v1). Distinct from /api/webhooks/stripe, which is the agency's
  // own Stripe. Security is the Stripe signature, verified inside the route
  // against that ONE sub-account's stored signing secret — not the session
  // cookie, since the caller is Stripe.
  /^\/api\/webhooks\/stripe\/sa\/[^/]+$/,
  // Per-sub-account Paystack webhook: /api/webhooks/paystack/sa/{subAccountId}.
  // Distinct from /api/webhooks/paystack, which is the agency's own Paystack
  // (Client Billing). Security is the x-paystack-signature HMAC, verified
  // inside the route against that ONE sub-account's stored secret key — which
  // for Paystack IS the signing key, so there is no separate webhook secret.
  /^\/api\/webhooks\/paystack\/sa\/[^/]+$/,
  // Paystack payment link: /pay/link/{token} (GET shows it, POST starts the
  // checkout). Already covered by the "/pay" entry in PUBLIC_PATHS (Client
  // Billing's checkout prefix); listed here too so it is findable.
  // The signed token is the credential, and neither handler marks anything
  // paid — only the verified webhook above does.
  /^\/pay\/link\/[^/]+$/,
  // Per-sub-account Webinar1 webhook: /api/webhooks/webinar1/sa/{subAccountId}
  // (Webinar1 integration). Security is the X-Webinar1-Signature header,
  // verified inside the route against that ONE sub-account's stored signing
  // secret — not the session cookie, since the caller is the connected
  // webinar deployment.
  /^\/api\/webhooks\/webinar1\/sa\/[^/]+$/,
  // Per-sub-account WhatsApp bridge inbound:
  // /api/webhooks/whatsapp/bridge/{subAccountId}. The caller is the
  // wa-agent-bridge process, which holds no session cookie. Security is two
  // credentials checked inside the route against that ONE sub-account's stored
  // secrets: the `LeadStack-Signature` HMAC over the raw body, and the bearer
  // token. The id in the path is untrusted routing info — it only selects
  // which stored secrets to verify against.
  /^\/api\/webhooks\/whatsapp\/bridge\/[^/]+$/,
  // Public booking-deposit card payment: /api/events/{token}/pay
  // (Payments v1). A regex, NOT a `/api/events` PUBLIC_PATHS prefix — that
  // would also expose /api/events/by-id/{id}/mark-paid and friends. Security
  // is the HMAC event token, re-hashed and compared against the stored
  // `publicTokenHash` inside the route.
  /^\/api\/events\/[^/]+\/pay$/,
  // Public reschedule + cancel, the /e/[token] page's own POSTs. Same
  // token-hash security as /pay above. Without this an anonymous visitor's
  // click 307s to /login instead of rescheduling/cancelling — the page
  // itself is public (`/e` above) but its actions were not.
  /^\/api\/events\/[^/]+\/reschedule$/,
  /^\/api\/events\/[^/]+\/cancel$/,
  // Calendar subscription feed: /api/sub-accounts/{id}/calendar.ics
  // Token-gated inside the route via verifyCalendarFeedToken — Google /
  // Apple / Outlook pollers are unauthenticated, so session-cookie auth
  // would block them. The HMAC token in `?t=` is the credential.
  /^\/api\/sub-accounts\/[^/]+\/calendar\.ics$/,
  // Tracked-link redirect: /l/{token} (per-contact) or /l/{linkId}
  // (unattributed). Public by definition — the recipient clicking it has
  // no session. Security is inside the route: an unsigned or forged token
  // resolves to nothing and 404s, and the destination is re-validated as
  // http(s) before the 302 so this can't become an open redirect.
  /^\/l\/[^/]+$/,
  // Tracked review-request link: /rr/{token} (SP5 d2), in review requests
  // sent while reminders are on. Public — the customer has no session. The
  // signed token is the credential; the route reads no identity header, 302s
  // only to the sub-account's configured https review link, else 404s.
  // Exactly one segment.
  /^\/rr\/[^/]+$/,
  // Public competitor comparison pages (SEO landing pages, e.g.
  // /leadstack-vs-gohighlevel). Slug is path-suffixed with a hyphen
  // rather than a slash so the PUBLIC_PATHS prefix-match logic can't
  // see it — regex is the only option here. Read-only public content;
  // no auth required. Each competitor has its own static route under
  // src/app/leadstack-vs-{slug}/page.tsx; this regex catches them all.
  /^\/leadstack-vs-[a-z0-9-]+$/,
  // Public Google reviews feed: /api/public/gbp/feed/{publicId}, fetched
  // cross-origin by a customer's website. The opaque publicId is the only
  // credential; the route never reads an identity header (a caller can send
  // its own on a public path), and applies the widget's origin allow-list,
  // a per-IP limit and a non-enumerating 404 itself. Exactly one segment.
  /^\/api\/public\/gbp\/feed\/[^/]+$/,
  // Snapshot share link (SP13): the /s/snapshot/{token} page and its file
  // download /api/public/snapshots/{token}. The recipient usually has no
  // account on this deployment. The share token is the credential — hashed
  // and checked against the stored share inside, with the same "invalid"
  // answer for unknown, revoked, expired and used-up links. Exactly one segment.
  /^\/s\/snapshot\/[^/]+$/,
  /^\/api\/public\/snapshots\/[^/]+$/,
];

export function isPublicPath(pathname: string): boolean {
  if (
    PUBLIC_PATHS.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`)
    )
  ) {
    return true;
  }
  return PUBLIC_PATH_PATTERNS.some((re) => re.test(pathname));
}

/**
 * Build the /login redirect for an unauthenticated request.
 *
 * MUST NOT use `request.nextUrl` for the ORIGIN. Under the standalone server
 * (systemd sets `HOSTNAME=127.0.0.1 PORT=4300`, behind a cloudflared tunnel)
 * `nextUrl` is derived from the server's own bind address, not the Host header
 * — so a logged-out visit to any protected route on crm.crestahq.com used to
 * 307 to `http://localhost:4300/login`, a dead address for every real user.
 * Verified 2026-09-06 against the live deployment: even an explicit
 * `Host: crm.crestahq.com` still produced localhost, so this is the app's own
 * doing, not the tunnel's. (It reproduces only when HOSTNAME is set, as systemd
 * sets it; without it the adapter emits a relative Location and the bug hides.)
 *
 * The mechanism is that Next emits a RELATIVE Location once the URL's host
 * matches the request Host, and an absolute one when it does not — so pinning
 * the configured origin fixes this by making them agree, rather than by
 * literally shipping the public origin in the header.
 *
 * `?redirect` carries the path AND query, so a deep link whose query is the
 * point (a snapshot share link's `?token=`) survives sign-in. The login form
 * runs it through `safeRedirect`, which refuses anything not same-origin.
 *
 * The path and query are still taken from `nextUrl` (preserving any existing
 * query string, as before); only protocol + host are pinned to
 * NEXT_PUBLIC_APP_URL. If that var is unset or malformed we fall back to the
 * previous behaviour rather than throwing inside auth middleware.
 */
export function loginRedirectUrl(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("redirect", `${pathname}${request.nextUrl.search}`);
  // A share link's bearer token belongs only inside `redirect` — not as a
  // top-level /login param where analytics and referrers would see it twice.
  url.searchParams.delete("token");

  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) {
    try {
      // Rebuild against the configured origin rather than assigning
      // protocol/host onto the clone: the URL `host` setter leaves an existing
      // port in place unless the new value carries one, which silently yielded
      // `https://crm.crestahq.com:4300`.
      return new URL(`${url.pathname}${url.search}`, configured);
    } catch {
      // Malformed env var — fall through to the request-derived origin.
    }
  }
  return url;
}

/**
 * Forward a public-path request WITHOUT `x-user-uid` / `x-user-email` — the
 * headers `handleValidToken` stamps from the verified Firebase token, which
 * every route/helper under src/lib/auth/*, src/lib/comms/route-auth.ts etc.
 * reads back as "the caller's identity" with no further check. On an
 * invalid/missing session those two branches used to call `NextResponse
 * .next()` with no `request` override, which forwards the ORIGINAL request
 * object — including any `x-user-uid` a caller sent itself.
 *
 * This was exploitable, not just theoretical: `/api/forms` is a PUBLIC_PATH
 * (needed for the unauthenticated submit endpoint), and
 * `DELETE /api/forms/[id]` trusts `x-user-uid` via `requireSubAccountMember`
 * to authorize the delete. Before this fix, anyone who knew (or guessed) an
 * active member's Firebase uid could set that header on an otherwise
 * session-less request and delete that member's forms + submissions —
 * no password, no session cookie, nothing else verified. See
 * src/app/api/forms/[id]/route.test.ts for the regression test through the
 * real route.
 */
export function withoutIdentityHeaders(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete("x-user-uid");
  headers.delete("x-user-email");
  return NextResponse.next({ request: { headers } });
}

/**
 * Vanity funnel subdomains (Labs): `{name}.{app domain}` serves the claimed
 * funnel at its root. Extracts the subdomain from the Host header, or null.
 *
 * Deliberately narrow:
 *  - only single-label subdomains of the app's own host (`a.b.domain` no)
 *  - `www` and the apex are never funnel hosts
 *  - `*.localhost` works too, so the whole path is testable with zero DNS
 *    (`7dsummer.localhost:3000` resolves in modern browsers by default).
 * NO database access here — middleware runs at the edge. It only rewrites to
 * the /fnh resolver, which does the claim lookup server-side. An unclaimed
 * subdomain therefore 404s at the resolver, not here.
 */
function funnelSubdomainFrom(request: NextRequest): string | null {
  const host = request.headers.get("host")?.toLowerCase().split(":")[0];
  if (!host) return null;

  let root: string;
  try {
    root = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "").hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    root = "localhost";
  }

  for (const base of [root, "localhost"]) {
    if (host === base || host === `www.${base}`) return null;
    if (host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub && !sub.includes(".") && sub !== "www") return sub;
    }
  }
  return null;
}

const STATIC_IMAGE_PATH = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;

export default function middleware(request: NextRequest) {
  // Vanity funnel hosts: rewrite ONLY the root path to the resolver. Every
  // other path (checkout /co, /api, /_next assets) is host-agnostic and works
  // unchanged, which is what keeps the buy flow functional on the subdomain.
  if (request.nextUrl.pathname === "/") {
    const sub = funnelSubdomainFrom(request);
    if (sub) {
      return NextResponse.rewrite(new URL(`/fnh/${sub}`, request.url));
    }
  }

  // Static images (excluded from session verification — they need no
  // identity) still pass through here so a caller-sent x-user-* header is
  // stripped before any route with an image-looking path can read it.
  if (STATIC_IMAGE_PATH.test(request.nextUrl.pathname)) {
    return withoutIdentityHeaders(request);
  }

  // Firebase not configured: nothing can be verified, so fail closed — no
  // caller-sent identity reaches a route, and protected paths go to /login.
  if (
    !process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
    !process.env.FIREBASE_ADMIN_PROJECT_ID
  ) {
    const pathname = request.nextUrl.pathname;
    if (isPublicPath(pathname)) return withoutIdentityHeaders(request);
    return NextResponse.redirect(loginRedirectUrl(request, pathname));
  }

  return authMiddleware(request, {
    loginPath: "/api/login",
    logoutPath: "/api/logout",
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    cookieName: "__session",
    cookieSignatureKeys: [
      process.env.COOKIE_SECRET_CURRENT ?? "",
      process.env.COOKIE_SECRET_PREVIOUS ?? "",
    ],
    cookieSerializeOptions: {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 24, // 12 days
    },
    serviceAccount: {
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID ?? "",
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL ?? "",
      privateKey: (process.env.FIREBASE_ADMIN_PRIVATE_KEY ?? "").replace(
        /\\n/g,
        "\n"
      ),
    },
    handleValidToken: async ({ decodedToken }, headers) => {
      // Allow authenticated users through
      // Attach user info to headers for downstream use
      headers.set("x-user-uid", decodedToken.uid);
      headers.set("x-user-email", decodedToken.email ?? "");

      return NextResponse.next({ request: { headers } });
    },
    handleInvalidToken: async () => {
      const pathname = request.nextUrl.pathname;

      // Allow public paths without authentication
      if (isPublicPath(pathname)) {
        return withoutIdentityHeaders(request);
      }

      // Redirect unauthenticated users to login for protected paths
      return NextResponse.redirect(loginRedirectUrl(request, pathname));
    },
    handleError: async () => {
      const pathname = request.nextUrl.pathname;

      // On error, allow public paths and redirect protected paths
      if (isPublicPath(pathname)) {
        return withoutIdentityHeaders(request);
      }

      return NextResponse.redirect(loginRedirectUrl(request, pathname));
    },
  });
}

export const config = {
  matcher: [
    // Image paths are NOT excluded here: they must still have x-user-*
    // stripped (see STATIC_IMAGE_PATH above), they just skip verification.
    "/((?!_next/static|_next/image|favicon.ico).*)",
    "/api/login",
    "/api/logout",
  ],
};
