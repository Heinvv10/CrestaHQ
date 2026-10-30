import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import { funnelAccent } from "@/lib/funnels/accent";
import { withCheckedBackground } from "@/lib/funnels/image-url";
import { FunnelSections } from "@/components/funnels/funnel-sections";
import { sectionsFromLegacyLanding } from "@/lib/funnels/sections";
import { fontPreset, typeScale } from "@/lib/funnels/typography";
import type { Funnel, FunnelSection } from "@/types/funnels";
import type { CheckoutPage } from "@/types/checkout-pages";

export const dynamic = "force-dynamic";

/**
 * The motion layer — one <style> block + ~600 bytes of inline vanilla JS.
 * Deliberately NOT a client component: no framework on the page, no
 * hydration, and the page stays fully server-rendered.
 *
 * Progressive enhancement throughout:
 *  - The reveal-hiding rule only applies under `html.fnlJs`, which the script
 *    stamps first thing — no-JS visitors and crawlers always see everything.
 *  - The countdown replaces a server-rendered static date, never a blank.
 *  - `prefers-reduced-motion` switches every animation off.
 * Class names are fnl-prefixed because this page inherits the root layout's
 * global CSS.
 */
const FNL_CSS = `
html.fnlJs .fnlFx{opacity:0;transform:translateY(26px);transition:opacity .7s cubic-bezier(.16,1,.3,1),transform .7s cubic-bezier(.16,1,.3,1)}
html.fnlJs .fnlFx.fnlIn{opacity:1;transform:none}
.fnlBtn{transition:transform .18s ease,box-shadow .18s ease}
.fnlBtn:hover{transform:translateY(-2px)}
.fnlMq{overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
.fnlMqIn{display:flex;gap:44px;align-items:center;width:max-content;animation:fnlMq 28s linear infinite}
@keyframes fnlMq{to{transform:translateX(-50%)}}
.fnlCar{scrollbar-width:thin}
.fnlSticky{transition:transform .28s ease,opacity .28s ease}
.fnlSticky.fnlHide{transform:translateY(110%);opacity:0;pointer-events:none}
::selection{background:var(--fnl-accent);color:#fff}
.fnlBand{position:relative}
.fnlBand::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.05;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.fnlH2::after{content:"";display:block;width:44px;height:3px;border-radius:2px;background:var(--fnl-accent);margin:14px auto 0;opacity:.9}
.fnlH2L::after{margin-left:0}
.fnlCard{transition:transform .18s ease,box-shadow .18s ease;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.fnlCard:hover{transform:translateY(-3px);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 14px 34px -16px rgba(0,0,0,.35)}
@media (max-width:600px){.fnlCmpRow{grid-template-columns:1fr!important}.fnlCmpHead{display:none!important}}
@media (prefers-reduced-motion: reduce){html.fnlJs .fnlFx{opacity:1;transform:none;transition:none}.fnlMqIn{animation:none}.fnlBtn{transition:none}.fnlCard{transition:none}.fnlCard:hover{transform:none}}
`;

const FNL_JS = `
document.documentElement.classList.add('fnlJs');
addEventListener('DOMContentLoaded',function(){
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('fnlIn');io.unobserve(e.target)}})},{threshold:.1,rootMargin:'0px 0px -40px 0px'});
document.querySelectorAll('.fnlFx').forEach(function(el){io.observe(el)});
var ds=document.querySelectorAll('[data-fnl-deadline]');
if(ds.length){var f=function(n){return n<10?'0'+n:''+n};var tick=function(){ds.forEach(function(el){var t=new Date(el.getAttribute('data-fnl-deadline')).getTime()-Date.now();if(isNaN(t))return;if(t<=0){el.textContent='Offer closed';return}var d=Math.floor(t/864e5),h=Math.floor(t%864e5/36e5),m=Math.floor(t%36e5/6e4),s=Math.floor(t%6e4/1e3);el.textContent=(d>0?d+'d ':'')+f(h)+'h '+f(m)+'m '+f(s)+'s left'})};tick();setInterval(tick,1e3)}
var st=document.querySelector('.fnlSticky');
var tails=[].slice.call(document.querySelectorAll('.fnlTail'));
if(st&&tails.length){var states=tails.map(function(){return false});
var io2=new IntersectionObserver(function(es){es.forEach(function(e){var i=tails.indexOf(e.target);if(i>-1)states[i]=e.isIntersecting});var any=false;for(var k=0;k<states.length;k++)if(states[k])any=true;st.classList.toggle('fnlHide',any)},{threshold:0});
tails.forEach(function(el){io2.observe(el)})}
});
`;

/**
 * Public funnel landing page — `/fn/[subAccountId]/[slug]` (Labs experiment).
 *
 * The CTA hands off to the linked checkout at `/co/[saId]/[slug]?fn=<slug>`;
 * that param is what returns the buyer to this funnel's thank-you step. It
 * carries a SLUG, never a URL — the session route rebuilds the destination
 * from our own origin, so it can't become an open redirect.
 *
 * 404s for draft funnels, a withdrawn Labs gate, or a missing sub-account.
 */

interface LoadResult {
  funnel: Funnel;
  checkoutSlug: string | null;
  sections: FunnelSection[];
  /** Footer identity, pulled from the sub-account — the funnel is published
   *  under the CLIENT's business, so the quiet footer carries their details
   *  and nothing else. No CTA down here: the last section already sold; the
   *  footer's job is legitimacy (who is this, how do I reach them). */
  business: {
    name: string;
    logoUrl: string | null;
    email: string | null;
    phone: string | null;
  };
}

async function load(
  subAccountId: string,
  slug: string,
): Promise<LoadResult | null> {
  const db = getAdminDb();

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) return null;
  const sub = subSnap.data() ?? {};
  // Withdraw the Labs gate and every funnel goes dark — deliberate, so an
  // experiment can be switched off without deleting anyone's content.
  if (sub.labsEnabledByAgency !== true) return null;

  const contact = (sub.accountContact ?? null) as {
    email?: string | null;
    phone?: string | null;
  } | null;
  const business = {
    name: (sub.name as string | undefined) || "This business",
    logoUrl:
      typeof sub.logoUrl === "string" && /^https?:\/\/.+/i.test(sub.logoUrl)
        ? (sub.logoUrl as string)
        : null,
    email: contact?.email ?? null,
    phone: contact?.phone ?? null,
  };

  const snap = await db
    .collection(`subAccounts/${subAccountId}/funnels`)
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const funnel = {
    id: snap.docs[0].id,
    ...(snap.docs[0].data() as Omit<Funnel, "id">),
  };
  if (funnel.status !== "published") return null;

  let checkoutSlug: string | null = null;
  if (funnel.checkoutPageId) {
    const co = await db
      .doc(`subAccounts/${subAccountId}/checkoutPages/${funnel.checkoutPageId}`)
      .get();
    const page = co.data() as CheckoutPage | undefined;
    if (page && page.status === "published") checkoutSlug = page.slug;
  }

  // Pre-section-library funnels have no `sections`; synthesise them from the
  // old flat `landing` block so live pages keep rendering.
  const raw =
    funnel.sections && funnel.sections.length > 0
      ? funnel.sections
      : sectionsFromLegacyLanding(funnel.landing);

  // Drop repeater sections that ended up with no rows. The AI deliberately
  // leaves testimonials/logos/stats empty when it has no real proof, and a
  // heading with nothing under it rendered as dead space on the live page.
  const REPEATERS = new Set([
    "benefits",
    "features",
    "testimonials",
    "faq",
    "logos",
    "steps",
    "stats",
    "comparison",
    "pricing",
  ]);
  // A background image is written into CSS url(…): checked here, before
  // anything is sent, and again in FunnelSections.
  const sections = raw
    .filter((s) => !REPEATERS.has(s.type) || s.items.length > 0)
    .map(withCheckedBackground);

  return { funnel, checkoutSlug, sections, business };
}

/** First real heading/subheading on the page — NOT the legacy landing block,
 *  which is placeholder text on every AI-drafted funnel. */
function pageMeta(sections: FunnelSection[], fallback: string) {
  const hero = sections.find((s) => s.type === "hero" && s.heading);
  const anyHeading = sections.find((s) => s.heading);
  const title = hero?.heading || anyHeading?.heading || fallback;
  const description =
    hero?.subheading ||
    sections.find((s) => s.subheading)?.subheading ||
    undefined;
  const image =
    sections.find((s) => s.mediaUrl && s.type !== "video")?.mediaUrl ??
    undefined;
  return { title, description, image };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
}): Promise<Metadata> {
  const { subAccountId, slug } = await params;
  const data = await load(subAccountId, slug);
  if (!data) return { title: "Offer" };

  const { title, description, image } = pageMeta(data.sections, data.funnel.name);
  // Canonical prefers the vanity subdomain when one is set — the path URL and
  // the subdomain serve identical content, and without this search engines
  // see duplicates and shares may split between the two addresses.
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const rootHost = (() => {
    try {
      return new URL(base).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();
  const canonical =
    data.funnel.subdomain && rootHost
      ? `https://${data.funnel.subdomain}.${rootHost}`
      : `${base}/fn/${subAccountId}/${slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      type: "website",
      url: canonical,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function FunnelLandingPage({
  params,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
}) {
  const { subAccountId, slug } = await params;
  const data = await load(subAccountId, slug);
  if (!data) notFound();

  const { funnel, checkoutSlug, sections, business } = data;
  // A stored accent reaches these styles only if it is a plain hex.
  const accent = funnelAccent(funnel.appearance?.accent);
  const dark = funnel.appearance?.theme === "dark";
  const t = typeScale(funnel.style);
  const preset = fontPreset(funnel.style?.fontPair);

  const ctaHref = checkoutSlug
    ? `/co/${subAccountId}/${checkoutSlug}?fn=${encodeURIComponent(funnel.slug)}`
    : funnel.ctaUrl;

  const defaultCta =
    sections.find((s) => s.ctaLabel)?.ctaLabel ||
    funnel.landing?.ctaLabel ||
    "Get started";

  // Sticky bar is CSS-only (position: fixed) rather than scroll-triggered —
  // no client component, no hydration cost on a page whose whole job is to
  // load fast. Bottom-anchored so it never covers the hero headline.
  const showSticky = funnel.stickyCta !== false && !!ctaHref;

  return (
    <>
      {/* display=swap: text paints in the fallback immediately and reflows
          when the webfont lands, so a slow CDN never blanks the page. */}
      {preset.href && <link rel="stylesheet" href={preset.href} />}
      <style dangerouslySetInnerHTML={{ __html: FNL_CSS }} />
      <script dangerouslySetInnerHTML={{ __html: FNL_JS }} />
      {/* Announcement bar — scrolls away with the page (a sticky top bar
          plus the sticky bottom CTA would sandwich the content in chrome).
          Rendered only when the operator/wand gave it text. */}
      {funnel.topBanner && (
        <div
          style={{
            background: accent,
            color: "#fff",
            textAlign: "center",
            padding: "9px 16px",
            fontSize: 13.5,
            fontWeight: 600,
            letterSpacing: "0.01em",
            fontFamily: t.bodyStack,
          }}
        >
          {funnel.topBanner}
        </div>
      )}
      <main
        style={
          {
            minHeight: "100vh",
            background: dark ? "#18181b" : "#ffffff",
            color: dark ? "#fafafa" : "#18181b",
            fontFamily: t.bodyStack,
            fontSize: t.body,
            // Feeds the CSS layer (H2 kicker, ::selection) so pseudo-elements
            // can use the operator's accent without inline styles.
            "--fnl-accent": accent,
          } as React.CSSProperties
        }
      >
        <FunnelSections
          sections={sections}
          ctx={{
            accent,
            dark,
            ctaHref: ctaHref ?? null,
            defaultCta,
            t,
            ctaSubtitle: funnel.ctaSubtitle || undefined,
          }}
        />
      </main>

      {/* Quiet footer — the client's business identity, NO CTA. The last
          section already sold; down here the job is legitimacy: who this is
          and how to reach them. <footer> is correct semantics — extractors
          treating it as chrome is exactly right for this content. */}
      <footer
        className="fnlTail"
        style={{
          background: dark ? "#101014" : "#f4f4f5",
          color: dark ? "#a1a1aa" : "#52525b",
          borderTop: dark
            ? "1px solid rgba(255,255,255,0.08)"
            : "1px solid rgba(0,0,0,0.07)",
          padding: showSticky ? "40px 20px 108px" : "40px 20px 44px",
          textAlign: "center",
          fontFamily: t.bodyStack,
          fontSize: 13,
        }}
      >
        {business.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={business.logoUrl}
            alt={business.name}
            style={{
              height: 30,
              width: "auto",
              maxWidth: 160,
              objectFit: "contain",
              margin: "0 auto 12px",
              display: "block",
            }}
          />
        )}
        <p
          style={{
            margin: 0,
            fontWeight: 600,
            color: dark ? "#e4e4e7" : "#3f3f46",
          }}
        >
          {business.name}
        </p>
        {(business.email || business.phone) && (
          <p style={{ margin: "6px 0 0" }}>
            {business.email && (
              <a
                href={`mailto:${business.email}`}
                style={{ color: "inherit", textDecoration: "underline" }}
              >
                {business.email}
              </a>
            )}
            {business.email && business.phone && " · "}
            {business.phone && (
              <a
                href={`tel:${business.phone}`}
                style={{ color: "inherit", textDecoration: "none" }}
              >
                {business.phone}
              </a>
            )}
          </p>
        )}
        <p style={{ margin: "10px 0 0", fontSize: 12, opacity: 0.75 }}>
          © {new Date().getFullYear()} {business.name}. All rights reserved.
        </p>
      </footer>

      {showSticky && (
        // .fnlSticky auto-hides (via the inline observer) whenever a .fnlTail
        // element — the final CTA band or the footer — is on screen. Without
        // this, the reader reaches the closing CTA with an identical button
        // floating directly beneath it: two matching buttons an inch apart,
        // which reads as a rendering bug rather than persistence.
        <div
          className="fnlSticky"
          style={{
            position: "fixed",
            insetInline: 0,
            bottom: 0,
            zIndex: 50,
            background: dark ? "rgba(16,16,20,0.94)" : "rgba(255,255,255,0.94)",
            backdropFilter: "blur(8px)",
            borderTop: dark
              ? "1px solid rgba(255,255,255,0.12)"
              : "1px solid rgba(0,0,0,0.08)",
            padding: "12px 16px",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <a
            href={ctaHref!}
            className="fnlBtn"
            style={{
              display: "inline-flex",
              flexDirection: "column",
              alignItems: "center",
              padding: "12px 34px",
              borderRadius: 10,
              background: `linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0) 55%), ${accent}`,
              color: "#fff",
              textDecoration: "none",
              fontFamily: t.bodyStack,
            }}
          >
            <span style={{ fontSize: 16, fontWeight: 800 }}>{defaultCta}</span>
            {funnel.ctaSubtitle && (
              <span style={{ fontSize: 12, opacity: 0.85 }}>
                {funnel.ctaSubtitle}
              </span>
            )}
          </a>
        </div>
      )}
    </>
  );
}
