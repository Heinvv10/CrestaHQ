import { NextResponse } from "next/server";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import { getPwaIconVersion } from "@/lib/pwa/icons-server";
import { ICON_STATIC_FALLBACKS } from "@/lib/pwa/icon-variants";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * PWA web-app manifest — served as a dynamic route (not the static
 * `app/manifest.ts` convention) so branding reflects live state.
 *
 * Identity is per deployment mode:
 *   - "custom" (buyer): app name/description merge the agency doc over
 *     CUSTOM_BRAND (resolveCustomBrand), and the manifest is linked
 *     site-wide from root-layout metadata.
 *   - "leadstack" (demo/template): fixed LeadStack identity, and the
 *     manifest is only ever LINKED from auth surfaces (pwa-links.tsx) —
 *     public pages carry no PWA references at all.
 *
 * Icons are shared logic in both modes: an owner-uploaded icon (Agency →
 * Settings → Mobile app icon) serves from /api/pwa/icon/* with the upload
 * timestamp as cache-buster; otherwise the mode's static defaults apply —
 * green "my CRM" for buyers, the chevron set for the demo (both via the
 * variant-aware ICON_STATIC_FALLBACKS).
 *
 * `start_url: /dashboard` — the legacy flat route redirects authenticated
 * users to their first-membership sub-account; unauthenticated opens land
 * on /login via middleware.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const isCustom = LANDING_VARIANT === "custom";
  const [brand, iconVersion] = await Promise.all([
    isCustom ? resolveCustomBrand() : Promise.resolve(null),
    getPwaIconVersion(),
  ]);

  const name = brand?.name ?? "LeadStack";
  const description =
    brand?.shortDescription ??
    "The all-in-one CRM for teams that actually close.";

  const icons = iconVersion
    ? [
        {
          src: `/api/pwa/icon/192?v=${iconVersion}`,
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: `/api/pwa/icon/512?v=${iconVersion}`,
          sizes: "512x512",
          type: "image/png",
        },
        {
          src: `/api/pwa/icon/maskable?v=${iconVersion}`,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ]
    : [
        {
          src: ICON_STATIC_FALLBACKS["192"],
          sizes: "192x192",
          type: "image/png",
        },
        {
          src: ICON_STATIC_FALLBACKS["512"],
          sizes: "512x512",
          type: "image/png",
        },
        {
          src: ICON_STATIC_FALLBACKS.maskable,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ];

  const manifest = {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description,
    id: "/",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#18181b",
    theme_color: "#18181b",
    icons,
    // Long-press-the-app-icon shortcuts. Static URLs by spec, so they use
    // the legacy flat routes, which redirect into the user's
    // first-membership sub-account.
    shortcuts: [
      {
        name: "Conversations",
        url: "/conversations",
        icons: [
          {
            src: ICON_STATIC_FALLBACKS["192"],
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "Contacts",
        url: "/contacts",
        icons: [
          {
            src: ICON_STATIC_FALLBACKS["192"],
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "Pipeline",
        url: "/pipeline",
        icons: [
          {
            src: ICON_STATIC_FALLBACKS["192"],
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
    ],
  };

  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      // Brand renames are rare — cache briefly so every page load doesn't
      // trigger a Firestore read, but changes still land within minutes.
      "Cache-Control": "public, max-age=300",
    },
  });
}
