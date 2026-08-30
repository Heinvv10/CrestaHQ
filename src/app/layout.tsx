import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Providers } from "@/components/providers";
import { RefTracker } from "@/components/affiliate/ref-tracker";
import { AnalyticsScripts } from "@/components/analytics-scripts";
import { SwRegister } from "@/components/pwa/sw-register";
import { PwaLinks } from "@/components/pwa/pwa-links";
import { CUSTOM_BRAND, LANDING_VARIANT } from "@/config/landing";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

// Metadata follows the same variant the landing page renders. The custom
// variant derives title + description from CUSTOM_BRAND so the buyer edits
// one config file to brand both the page chrome and the rendered landing.
export const metadata: Metadata = {
  ...(LANDING_VARIANT === "custom"
    ? {
        title: `${CUSTOM_BRAND.name} — ${CUSTOM_BRAND.tagline}`,
        description: CUSTOM_BRAND.shortDescription,
      }
    : {
        title: "LeadStack — Own Your CRM, Never Rent It Again",
        description:
          "The GoHighLevel alternative you own. One payment, unlimited sub-accounts, AI agents, your code and data. The GHL alternative without the monthly rent.",
      }),
  // Favicon per deployment mode (the former src/app/icon.svg file
  // convention would override this metadata, so both marks live in
  // /public instead): buyers default to the green "my CRM" badge,
  // the LeadStack demo keeps the chevron.
  //
  // PWA — only on custom-branded deployments. In "leadstack" template/demo
  // mode the app isn't the buyer's brand yet, so we don't advertise
  // installability at all (no manifest link = no browser install prompt).
  // The manifest route resolves live agency branding server-side; the
  // apple icon serves via the route so an owner upload applies (302s to
  // the static PNG until then).
  ...(LANDING_VARIANT === "custom"
    ? {
        manifest: "/manifest.webmanifest",
        icons: {
          icon: "/mycrm-mark.svg",
          apple: "/api/pwa/icon/apple",
        },
        appleWebApp: {
          capable: true,
          title: CUSTOM_BRAND.name,
          statusBarStyle: "default" as const,
        },
      }
    : {
        icons: { icon: "/leadstack-mark.svg" },
      }),
};

export const viewport: Viewport = {
  themeColor: "#18181b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} antialiased`}
      >
        {process.env.NEXT_PUBLIC_GTM_ID && (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${process.env.NEXT_PUBLIC_GTM_ID}`}
              height="0"
              width="0"
              style={{ display: "none", visibility: "hidden" }}
            />
          </noscript>
        )}
        <Providers>{children}</Providers>
        <SwRegister />
        <PwaLinks />
        <RefTracker />
        {process.env.NEXT_PUBLIC_META_PIXEL_ID && (
          <noscript>
            {/* Meta Pixel no-JS fallback — must be a bare <img> tag.
                next/image requires client JS and can't run inside <noscript>,
                which is the entire reason this fallback exists. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              height="1"
              width="1"
              style={{ display: "none" }}
              alt=""
              src={`https://www.facebook.com/tr?id=${process.env.NEXT_PUBLIC_META_PIXEL_ID}&ev=PageView&noscript=1`}
            />
          </noscript>
        )}
        <AnalyticsScripts />
      </body>
    </html>
  );
}
