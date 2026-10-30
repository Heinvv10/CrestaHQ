import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit `.next/standalone/server.js` so the app can run under systemd on our
  // own box (velo-server) without node_modules — the pattern every other
  // Next.js service there already uses. Harmless on Vercel, which ignores it.
  output: "standalone",

  // The AI "where do I get this key" guide route reads these docs from disk at
  // runtime. They aren't imported by code, so trace them into that function's
  // bundle explicitly — otherwise readFileSync 404s on Vercel.
  outputFileTracingIncludes: {
    "/api/agency/setup/guide": ["./CLAUDE.md", "./SETUP.md", "./.env.example"],
    // The mystery shop's form engine runs in its own container; the app only
    // reads the image tag the deploy wrote (scripts/form-engine-image.mjs).
    "/api/automations/prospecting/mystery-shop-form": ["./docker/form-engine/dist/TAG"],
    "/api/sub-accounts/*/prospecting/mystery-shop": ["./docker/form-engine/dist/TAG"],
  },

  experimental: {
    // Because src/middleware.ts matches (nearly) every path, Next clones every
    // request body for it and TRUNCATES the clone at 10 MB by default — the
    // route handler then reads the truncated copy, silently, with no error.
    // The wa-agent-bridge posts a 16 MiB attachment as ~21.5 MiB of base64 JSON
    // to /api/webhooks/whatsapp/bridge/*; truncated, that body fails the HMAC
    // (403) and the file is lost — the bridge then re-posts text-only, so the
    // text survives. 24 MB = 16 MiB × 4/3 + envelope. Build-time: takes
    // effect on the next deploy. Reproduced on Next 15.5.12 (PR #148).
    //
    // The composer no longer needs this: it PUTs attachments straight to
    // Storage and sends only an id (staged-upload.ts), and the send route
    // takes no inline file. The bridge webhook above is why it cannot come
    // back down.
    //
    // Trade-off, accepted: Next has no per-route form of this, so EVERY
    // middleware-matched route may now buffer up to 24 MB (was 10 MB) for an
    // unauthenticated request — ~2.4x the memory an abusive client can pin
    // per request, including the bridge webhook, which must read the raw body
    // before it can check the HMAC. No route was found to become exploitable.
    middlewareClientMaxBodySize: "24mb",
  },
  async headers() {
    return [
      {
        // The web-chat embed iframe target — must be loadable cross-
        // origin from any buyer's site. CSP frame-ancestors '*' is the
        // explicit way to allow that; without it, some hosts (and the
        // Vercel default in certain configs) inject X-Frame-Options
        // DENY/SAMEORIGIN which would block third-party iframes.
        source: "/embed/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *;",
          },
          // Suppress the legacy header in case anything upstream tries
          // to add it. (Vercel doesn't by default but belt-and-braces.)
          { key: "X-Frame-Options", value: "ALLOWALL" },
        ],
      },
      {
        // Widget loader: long-cache and serve to any origin so the
        // <script> tag works on any buyer's site.
        source: "/widget.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=300" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        // Booking widget loader: same pattern as /widget.js — long-cache,
        // any origin, so the <script> tag works on any buyer's site.
        source: "/booking-embed.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=300" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        // Google reviews embed script — the same pattern as /widget.js. This
        // is static code; the DATA it fetches (/api/public/gbp/feed/…) has
        // its own per-widget origin allow-list and never answers `*`.
        source: "/embed/gbp-reviews.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=300" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
