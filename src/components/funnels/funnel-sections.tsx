import type { TypeScale } from "@/lib/funnels/typography";
import type {
  FunnelSection,
  FunnelSectionBackground,
} from "@/types/funnels";

/**
 * Public funnel section renderer.
 *
 * Server component, inline styles — same reasoning as the checkout page: this
 * is a public page an operator may theme, and it must not depend on the
 * dashboard's Tailwind context.
 *
 * One switch over the section type. Adding a section = one more case.
 */

interface Ctx {
  accent: string;
  dark: boolean;
  /** Injected per-section by FunnelSections. */
  band?: ReturnType<typeof band>;
  /** Where every CTA button points. Null hides them. */
  ctaHref: string | null;
  /** Fallback label when a CTA section has none. */
  defaultCta: string;
  /** Resolved type scale for the whole page. */
  t: TypeScale;
  /** Second line inside every CTA button. */
  ctaSubtitle?: string;
}

/**
 * Resolve a band into real colours.
 *
 * Each section renders as a FULL-BLEED strip with a contained inner column.
 * That edge-to-edge colour change is what separates a designed funnel page
 * from a long document — the first version had one flat background and read
 * as exactly that.
 */
function band(
  bg: FunnelSectionBackground | undefined,
  accent: string,
  dark: boolean,
): { background: string; fg: string; muted: string; card: string; onDark: boolean } {
  const base = {
    background: dark ? "#18181b" : "#ffffff",
    fg: dark ? "#fafafa" : "#18181b",
    muted: dark ? "#a1a1aa" : "#52525b",
    card: dark ? "#27272a" : "#ffffff",
    onDark: dark,
  };
  switch (bg) {
    case "muted":
      return {
        ...base,
        background: dark ? "#212124" : "#f4f4f5",
        card: dark ? "#2a2a2e" : "#ffffff",
      };
    case "dark":
      return {
        // Not flat black: a faint accent glow bleeding in from the top gives
        // the band atmosphere — the difference between "dark mode" and
        // "designed dark". Layered gradients over a base colour, no assets.
        background: `radial-gradient(900px 420px at 50% -10%, ${accent}2e, transparent 62%), #101014`,
        fg: "#ffffff",
        muted: "#a1a1aa",
        card: "#1c1c22",
        onDark: true,
      };
    case "accent":
      return {
        // Top-light sheen so the band reads as lit, not filled in.
        background: `radial-gradient(820px 400px at 50% 0%, rgba(255,255,255,0.17), transparent 58%), ${accent}`,
        fg: "#ffffff",
        // Readable on an arbitrary operator-chosen accent without knowing its
        // luminance — a translucent white reads correctly on light and dark.
        muted: "rgba(255,255,255,0.82)",
        card: "rgba(255,255,255,0.12)",
        onDark: true,
      };
    case "accentSoft":
      return {
        ...base,
        background: dark ? "#1d1b26" : `${accent}12`,
        card: dark ? "#26232f" : "#ffffff",
      };
    default:
      return base;
  }
}

export function FunnelSections({
  sections,
  ctx,
}: {
  sections: FunnelSection[];
  ctx: Ctx;
}) {
  return (
    <>
      {sections.map((s, i) => {
        // Image-as-background: the photo becomes the band itself under a dark
        // overlay gradient, so text stays readable on ANY image without
        // knowing its luminance. Forces the dark palette for the same reason.
        // Applies to the hero and to image-interlude sections — the mid-page
        // photo break with an overlay line that real sales pages use.
        const bgImage =
          (s.type === "hero" || s.type === "image") &&
          s.mediaAsBackground &&
          s.mediaUrl
            ? s.mediaUrl
            : null;
        const b = bgImage
          ? band("dark", ctx.accent, ctx.dark)
          : band(s.background, ctx.accent, ctx.dark);
        // The sticky CTA bar hides while a tail element is on screen — the
        // closing CTA band earns that suppression, the sections above don't.
        const isTail =
          i === sections.length - 1 &&
          (s.type === "cta" || s.type === "offer" || s.type === "pricing");
        return (
          <div
            key={s.id}
            className={isTail ? "fnlBand fnlTail" : "fnlBand"}
            style={{
              background: bgImage
                ? `radial-gradient(900px 420px at 50% -10%, ${ctx.accent}33, transparent 60%), linear-gradient(rgba(10,10,14,0.68), rgba(10,10,14,0.84)), url(${bgImage}) center / cover no-repeat`
                : b.background,
              color: b.fg,
              padding:
                s.type === "hero"
                  ? "92px 20px 76px"
                  : bgImage
                    ? "104px 20px"
                    : "56px 20px",
            }}
          >
            {/* .fnlFx = scroll-reveal target. The hiding rule only applies
                once JS stamps `fnlJs` on <html>, so no-JS visitors and
                crawlers always see full content. */}
            <div className="fnlFx">
              <Section s={s} ctx={{ ...ctx, band: b }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

function Section({ s, ctx }: { s: FunnelSection; ctx: Ctx }) {
  const { accent } = ctx;
  const b = ctx.band ?? band(s.background, ctx.accent, ctx.dark);
  const dark = b.onDark;
  const muted = b.muted;
  const card = b.card;
  const line = dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.09)";
  // On an accent band the button must invert or it disappears into it.
  const btnBg = s.background === "accent" ? "#ffffff" : accent;
  const btnFg = s.background === "accent" ? accent : "#ffffff";
  const tick = b.onDark ? "#ffffff" : accent;

  const t = ctx.t;
  const wrap: React.CSSProperties = {
    margin: "0 auto",
    maxWidth: t.width,
    textAlign: s.alignLeft ? "left" : undefined,
  };
  // Bands own the vertical rhythm now, so sections no longer add their own
  // top margin — otherwise spacing doubles up inside a coloured strip.
  const block: React.CSSProperties = wrap;

  switch (s.type) {
    case "hero":
      return (
        // NOT <header>: content extractors and readers treat that as site
        // chrome and strip it — the hero was being dropped from scrapes and
        // previews entirely.
        <section style={{ ...wrap, textAlign: s.alignLeft ? "left" : "center" }}>
          {s.badge && (
            <p
              style={{
                margin: "0 0 18px",
                display: "inline-flex",
                padding: "6px 14px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: 700,
                letterSpacing: "0.09em",
                textTransform: "uppercase",
                background: b.onDark ? "rgba(255,255,255,0.13)" : `${accent}14`,
                color: b.onDark ? "#fff" : accent,
              }}
            >
              {s.badge}
            </p>
          )}
          <h1
            style={{
              margin: 0,
              fontSize: t.h1,
              lineHeight: 1.05,
              fontWeight: t.weight,
              letterSpacing: t.tracking,
              textTransform: t.transform,
              fontFamily: t.headingStack,
            }}
          >
            {s.heading}
          </h1>
          {s.subheading && (
            <p
              style={{
                margin: "16px auto 0",
                maxWidth: 560,
                fontSize: 18,
                lineHeight: 1.6,
                color: muted,
              }}
            >
              {s.subheading}
            </p>
          )}
          {s.mediaUrl && !s.mediaAsBackground && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={s.mediaUrl}
              alt=""
              style={{
                marginTop: 30,
                width: "100%",
                borderRadius: 16,
                display: "block",
                boxShadow: "0 24px 60px -24px rgba(0,0,0,0.45)",
              }}
            />
          )}
          {ctx.ctaHref && s.ctaLabel && (
            <Cta
              href={ctx.ctaHref}
              label={s.ctaLabel}
              bg={btnBg}
              fg={btnFg}
              subtitle={ctx.ctaSubtitle}
            />
          )}
        </section>
      );

    case "video":
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          {s.mediaUrl && (
            <div
              style={{
                position: "relative",
                paddingBottom: "56.25%",
                height: 0,
                borderRadius: 14,
                overflow: "hidden",
                background: "#000",
              }}
            >
              <iframe
                src={s.mediaUrl}
                title={s.heading || "Video"}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                allowFullScreen
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  border: 0,
                }}
              />
            </div>
          )}
        </section>
      );

    case "benefits":
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "0 auto",
              maxWidth: 560,
              display: "grid",
              gap: 13,
            }}
          >
            {s.items.map((it, i) => (
              <li
                key={i}
                style={{
                  display: "flex",
                  gap: 11,
                  alignItems: "flex-start",
                  fontSize: 16,
                  lineHeight: 1.55,
                }}
              >
                <span aria-hidden style={{ color: tick, fontWeight: 700 }}>
                  ✓
                </span>
                <span>{it.title}</span>
              </li>
            ))}
          </ul>
        </section>
      );

    case "features":
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          {s.subheading && <Lede color={muted}>{s.subheading}</Lede>}
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            }}
          >
            {s.items.map((it, i) => (
              <div
                key={i}
                className="fnlCard"
                style={{
                  background: card,
                  border: `1px solid ${line}`,
                  borderRadius: 12,
                  padding: 18,
                }}
              >
                <p style={{ margin: 0, fontSize: 15.5, fontWeight: 700 }}>
                  {it.title}
                </p>
                {it.body && (
                  <p
                    style={{
                      margin: "7px 0 0",
                      fontSize: 14,
                      lineHeight: 1.55,
                      color: muted,
                    }}
                  >
                    {it.body}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      );

    case "testimonials":
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          {/* 3+ quotes become a horizontal scroll-snap carousel — no JS,
              works with touch/trackpad/keyboard. 1-2 stay stacked; a
              carousel of two reads as broken, not designed. */}
          <div
            className={s.items.length > 2 ? "fnlCar" : undefined}
            style={
              s.items.length > 2
                ? {
                    display: "flex",
                    gap: 14,
                    overflowX: "auto",
                    scrollSnapType: "x mandatory",
                    paddingBottom: 10,
                  }
                : { display: "grid", gap: 14 }
            }
          >
            {s.items.map((it, i) => (
              <figure
                key={i}
                style={{
                  margin: 0,
                  background: card,
                  border: `1px solid ${line}`,
                  borderRadius: 14,
                  padding: 22,
                  ...(s.items.length > 2
                    ? {
                        minWidth: "min(340px, 85%)",
                        scrollSnapAlign: "start",
                        flexShrink: 0,
                      }
                    : {}),
                }}
              >
                {typeof it.rating === "number" && it.rating > 0 && (
                  <p
                    aria-label={`${it.rating} out of 5`}
                    style={{
                      margin: "0 0 8px",
                      fontSize: 14,
                      letterSpacing: 2,
                      color: "#f59e0b",
                    }}
                  >
                    {"★".repeat(Math.min(5, Math.round(it.rating)))}
                  </p>
                )}
                <blockquote style={{ margin: 0, fontSize: 16, lineHeight: 1.65 }}>
                  “{it.title}”
                </blockquote>
                <figcaption
                  style={{
                    marginTop: 14,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 13,
                    color: muted,
                  }}
                >
                  {it.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={it.imageUrl}
                      alt=""
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        objectFit: "cover",
                      }}
                    />
                  )}
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ color: "inherit" }}>{it.body}</strong>
                    {it.meta ? ` · ${it.meta}` : ""}
                  </span>
                  {it.result && (
                    <span
                      style={{
                        flexShrink: 0,
                        borderRadius: 999,
                        padding: "4px 10px",
                        fontSize: 12,
                        fontWeight: 700,
                        background: b.onDark
                          ? "rgba(255,255,255,0.14)"
                          : `${accent}14`,
                        color: b.onDark ? "#fff" : accent,
                      }}
                    >
                      {it.result}
                    </span>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      );

    case "faq":
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          <div style={{ display: "grid", gap: 10 }}>
            {s.items.map((it, i) => (
              <details
                key={i}
                style={{
                  background: card,
                  border: `1px solid ${line}`,
                  borderRadius: 12,
                  padding: "14px 18px",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: 15.5,
                    fontWeight: 600,
                    listStyle: "none",
                  }}
                >
                  {it.title}
                </summary>
                {it.body && (
                  <p
                    style={{
                      margin: "10px 0 0",
                      fontSize: 14.5,
                      lineHeight: 1.6,
                      color: muted,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {it.body}
                  </p>
                )}
              </details>
            ))}
          </div>
        </section>
      );

    case "offer":
      return (
        <section
          style={{
            ...block,
            background: card,
            border: `2px solid ${accent}`,
            borderRadius: 18,
            padding: "30px 26px",
            textAlign: "center",
          }}
        >
          {s.heading && (
            <h2 style={{ margin: 0, fontSize: 25, fontWeight: 800 }}>
              {s.heading}
            </h2>
          )}
          {s.subheading && (
            <p
              style={{
                margin: "10px auto 0",
                maxWidth: 480,
                fontSize: 16,
                lineHeight: 1.6,
                color: muted,
              }}
            >
              {s.subheading}
            </p>
          )}
          {s.items.length > 0 && (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "20px auto 0",
                maxWidth: 420,
                display: "grid",
                gap: 10,
                textAlign: "left",
              }}
            >
              {s.items.map((it, i) => (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    gap: 10,
                    fontSize: 15,
                    lineHeight: 1.5,
                  }}
                >
                  <span aria-hidden style={{ color: tick, fontWeight: 700 }}>
                    ✓
                  </span>
                  <span>{it.title}</span>
                </li>
              ))}
            </ul>
          )}
          {ctx.ctaHref && (
            <Cta
              href={ctx.ctaHref}
              label={s.ctaLabel || ctx.defaultCta}
              bg={btnBg}
              fg={btnFg}
              subtitle={ctx.ctaSubtitle}
            />
          )}
        </section>
      );

    case "guarantee":
      return (
        <section
          style={{
            ...block,
            background: `${accent}0d`,
            border: `1px solid ${accent}40`,
            borderRadius: 14,
            padding: "22px 24px",
            textAlign: "center",
          }}
        >
          {s.heading && (
            <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
              {s.heading}
            </p>
          )}
          {s.body && (
            <p
              style={{
                margin: "8px auto 0",
                maxWidth: 520,
                fontSize: 14.5,
                lineHeight: 1.6,
                color: muted,
                whiteSpace: "pre-wrap",
              }}
            >
              {s.body}
            </p>
          )}
        </section>
      );

    case "bio":
      return (
        <section
          style={{
            ...block,
            display: "flex",
            gap: 20,
            alignItems: "flex-start",
            flexWrap: "wrap",
          }}
        >
          {s.mediaUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={s.mediaUrl}
              alt=""
              style={{
                width: 110,
                height: 110,
                borderRadius: "50%",
                objectFit: "cover",
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ flex: 1, minWidth: 240 }}>
            {s.heading && (
              <p style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                {s.heading}
              </p>
            )}
            {s.body && (
              <p
                style={{
                  margin: "8px 0 0",
                  fontSize: 15,
                  lineHeight: 1.65,
                  color: muted,
                  whiteSpace: "pre-wrap",
                }}
              >
                {s.body}
              </p>
            )}
          </div>
        </section>
      );

    case "logos":
      return (
        <section style={{ ...block, textAlign: "center" }}>
          {s.heading && (
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 12,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: muted,
              }}
            >
              {s.heading}
            </p>
          )}
          {s.items.length >= 5 ? (
            // Auto-scrolling marquee (pure CSS — the FHL logo-strip effect).
            // The row is rendered TWICE and translated -50%, so the loop is
            // seamless. Static flex below for short lists, where scrolling
            // three names would look busted rather than busy.
            <div className="fnlMq">
              <div className="fnlMqIn">
                {[...s.items, ...s.items].map((it, i) =>
                  it.meta ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={it.meta}
                      alt={it.title}
                      style={{ height: 30, opacity: 0.75, flexShrink: 0 }}
                    />
                  ) : (
                    <span
                      key={i}
                      style={{
                        fontSize: 15,
                        fontWeight: 600,
                        color: muted,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {it.title}
                    </span>
                  ),
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 22,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              {s.items.map((it, i) =>
                it.meta ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={it.meta}
                    alt={it.title}
                    style={{ height: 30, opacity: 0.75 }}
                  />
                ) : (
                  <span
                    key={i}
                    style={{ fontSize: 15, fontWeight: 600, color: muted }}
                  >
                    {it.title}
                  </span>
                ),
              )}
            </div>
          )}
        </section>
      );

    case "urgency":
      return (
        <section
          style={{
            ...block,
            background: "#f59e0b14",
            border: "1px solid #f59e0b55",
            borderRadius: 12,
            padding: "16px 20px",
            textAlign: "center",
          }}
        >
          {s.heading && (
            <p style={{ margin: 0, fontSize: 15.5, fontWeight: 700 }}>
              {s.heading}
            </p>
          )}
          {s.body && (
            <p style={{ margin: "6px 0 0", fontSize: 14, color: muted }}>
              {s.body}
            </p>
          )}
          {s.deadline && (
            // Server renders the static date; the inline countdown script
            // replaces this element's text with a live "2d 04h 12m 05s left"
            // ticker. No JS → the date stays, so nothing depends on the
            // script.
            <p
              data-fnl-deadline={s.deadline}
              style={{
                margin: "8px 0 0",
                fontSize: 15,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              Closes{" "}
              {new Date(s.deadline).toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </section>
      );

    case "text":
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          {s.body && (
            <p
              style={{
                margin: 0,
                fontSize: 16,
                lineHeight: 1.7,
                color: muted,
                whiteSpace: "pre-wrap",
              }}
            >
              {s.body}
            </p>
          )}
        </section>
      );

    case "image":
      // Interlude mode: the band IS the photo (rendered by the wrapper) and
      // this just sets one big overlay line on it — the mid-page image break.
      if (s.mediaAsBackground && s.mediaUrl) {
        return (
          <section style={{ ...block, maxWidth: 680, textAlign: "center" }}>
            {s.heading && (
              <p
                style={{
                  margin: 0,
                  fontSize: Math.round(t.h2 * 1.05),
                  lineHeight: 1.2,
                  fontWeight: t.weight,
                  letterSpacing: t.tracking,
                  textTransform: t.transform,
                  fontFamily: t.headingStack,
                  textShadow: "0 2px 24px rgba(0,0,0,0.45)",
                }}
              >
                {s.heading}
              </p>
            )}
            {s.body && (
              <p
                style={{
                  margin: "12px 0 0",
                  fontSize: 15.5,
                  lineHeight: 1.6,
                  color: muted,
                }}
              >
                {s.body}
              </p>
            )}
          </section>
        );
      }
      return (
        <section style={block}>
          {s.mediaUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={s.mediaUrl}
              alt={s.body || ""}
              style={{
                width: "100%",
                borderRadius: 14,
                display: "block",
                boxShadow: "0 24px 60px -24px rgba(0,0,0,0.4)",
              }}
            />
          )}
          {s.body && (
            <p
              style={{
                margin: "10px 0 0",
                fontSize: 13,
                textAlign: "center",
                color: muted,
              }}
            >
              {s.body}
            </p>
          )}
        </section>
      );

    case "cta":
      return (
        <section style={{ ...block, textAlign: "center" }}>
          {s.heading && (
            <h2 style={{ margin: 0, fontSize: 26, fontWeight: 800 }}>
              {s.heading}
            </h2>
          )}
          {s.subheading && (
            <p
              style={{
                margin: "10px auto 0",
                maxWidth: 480,
                fontSize: 16,
                lineHeight: 1.6,
                color: muted,
              }}
            >
              {s.subheading}
            </p>
          )}
          {ctx.ctaHref && (
            <Cta
              href={ctx.ctaHref}
              label={s.ctaLabel || ctx.defaultCta}
              bg={btnBg}
              fg={btnFg}
              subtitle={ctx.ctaSubtitle}
            />
          )}
        </section>
      );

    case "steps":
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          {s.subheading && <Lede color={muted}>{s.subheading}</Lede>}
          <ol
            style={{
              listStyle: "none",
              counterReset: "step",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 14,
            }}
          >
            {s.items.map((it, i) => (
              <li
                key={i}
                style={{
                  display: "flex",
                  gap: 14,
                  alignItems: "flex-start",
                  background: card,
                  border: `1px solid ${line}`,
                  borderRadius: 12,
                  padding: 16,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: b.onDark ? "rgba(255,255,255,0.16)" : `${accent}1a`,
                    color: b.onDark ? "#fff" : accent,
                    fontWeight: 800,
                    fontSize: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {i + 1}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 16, fontWeight: 700 }}>
                    {it.title}
                  </span>
                  {it.body && (
                    <span
                      style={{
                        display: "block",
                        marginTop: 4,
                        fontSize: 14.5,
                        lineHeight: 1.55,
                        color: muted,
                      }}
                    >
                      {it.body}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      );

    case "stats":
      return (
        <section style={{ ...block, textAlign: "center" }}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          <div
            style={{
              display: "grid",
              gap: 20,
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            }}
          >
            {s.items.map((it, i) => (
              <div key={i}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 38,
                    fontWeight: 800,
                    letterSpacing: "-0.03em",
                    lineHeight: 1.05,
                  }}
                >
                  {it.title}
                </p>
                {it.body && (
                  <p style={{ margin: "6px 0 0", fontSize: 14, color: muted }}>
                    {it.body}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      );

    case "comparison": {
      // PAIRED rows, not two independent lists: each item is one contrast
      // (title = without, body = with), and the two sides share a grid row so
      // they always sit level — unequal text lengths can't drift the columns
      // apart. The .fnlCmpRow media query stacks each pair on phones (pain
      // directly above its payoff), where side-by-side headers stop meaning
      // anything, so .fnlCmpHead hides there too.
      const pairRow = {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "10px 14px",
      } as const;
      const cmpCell = (side: "without" | "with") => ({
        display: "flex",
        gap: 9,
        alignItems: "flex-start",
        background: card,
        border:
          side === "with"
            ? `2px solid ${b.onDark ? "#ffffff" : accent}`
            : `1px solid ${line}`,
        borderRadius: 10,
        padding: "12px 14px",
        fontSize: 14.5,
        lineHeight: 1.5,
        color: side === "without" ? muted : "inherit",
      });
      const colLabel = {
        margin: 0,
        fontSize: 12,
        letterSpacing: "0.07em",
        textTransform: "uppercase" as const,
        color: muted,
      };
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          {s.subheading && <Lede color={muted}>{s.subheading}</Lede>}
          <div style={{ display: "grid", gap: 10 }}>
            <div className="fnlCmpRow fnlCmpHead" style={pairRow}>
              <p style={colLabel}>Without</p>
              <p style={colLabel}>With</p>
            </div>
            {s.items
              .filter((it) => it.title || it.body)
              .map((it, i) => (
                <div key={i} className="fnlCmpRow" style={pairRow}>
                  <div style={cmpCell("without")}>
                    <span aria-hidden style={{ opacity: 0.7 }}>
                      ✕
                    </span>
                    <span>{it.title}</span>
                  </div>
                  <div style={cmpCell("with")}>
                    <span aria-hidden style={{ opacity: 0.7 }}>
                      ✓
                    </span>
                    <span>{it.body}</span>
                  </div>
                </div>
              ))}
          </div>
        </section>
      );
    }

    case "pullquote":
      return (
        <section style={{ ...block, maxWidth: 680, textAlign: "center" }}>
          {/* Oversized serif quote mark — pure decoration, marked aria-hidden.
              Georgia because the mark should contrast the heading face. */}
          <span
            aria-hidden
            style={{
              display: "block",
              fontFamily: "Georgia, serif",
              fontSize: 76,
              lineHeight: 0.55,
              opacity: 0.28,
              marginBottom: 6,
            }}
          >
            “
          </span>
          <p
            style={{
              margin: 0,
              fontSize: 27,
              lineHeight: 1.35,
              fontWeight: 700,
              letterSpacing: "-0.015em",
            }}
          >
            {s.body}
          </p>
        </section>
      );

    case "story":
      return (
        <article
          style={{
            ...wrap,
            maxWidth: Math.min(t.width, 720),
            textAlign: "left",
          }}
        >
          {s.heading && (
            <H2 t={t} align="left">
              {s.heading}
            </H2>
          )}
          {s.attribution && (
            <p
              style={{
                margin: "-12px 0 18px",
                fontSize: 13.5,
                color: muted,
                fontWeight: 600,
              }}
            >
              {s.attribution}
            </p>
          )}
          {s.mediaUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={s.mediaUrl}
              alt=""
              style={{
                width: "100%",
                borderRadius: 14,
                display: "block",
                marginBottom: 22,
              }}
            />
          )}
          {s.subheading && (
            <p
              style={{
                margin: "0 0 16px",
                fontSize: 18,
                lineHeight: 1.6,
                fontWeight: 600,
              }}
            >
              {s.subheading}
            </p>
          )}
          {s.body && (
            <div
              style={{
                fontSize: 17,
                lineHeight: 1.75,
                color: muted,
                whiteSpace: "pre-wrap",
              }}
            >
              {s.body}
            </div>
          )}
        </article>
      );

    case "pricing":
      return (
        <section style={block}>
          {s.heading && <H2 t={t}>{s.heading}</H2>}
          {s.subheading && <Lede color={muted}>{s.subheading}</Lede>}
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            }}
          >
            {s.items.map((it, i) => (
              <div
                key={i}
                className="fnlCard"
                style={{
                  background: card,
                  border: `1px solid ${line}`,
                  borderRadius: 14,
                  padding: 20,
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: muted,
                  }}
                >
                  {it.title}
                </p>
                {it.meta && (
                  <p
                    style={{
                      margin: "8px 0 0",
                      fontSize: 32,
                      fontWeight: 800,
                      letterSpacing: "-0.02em",
                      fontFamily: t.headingStack,
                    }}
                  >
                    {it.meta}
                  </p>
                )}
                {it.result && (
                  <p
                    style={{
                      margin: "2px 0 0",
                      fontSize: 13,
                      color: muted,
                      textDecoration: "line-through",
                    }}
                  >
                    {it.result}
                  </p>
                )}
                {it.body && (
                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "14px 0 0",
                      display: "grid",
                      gap: 7,
                      fontSize: 14,
                      lineHeight: 1.5,
                    }}
                  >
                    {it.body
                      .split("\n")
                      .filter(Boolean)
                      .map((row, k) => (
                        <li key={k} style={{ display: "flex", gap: 8 }}>
                          <span aria-hidden style={{ color: tick }}>
                            ✓
                          </span>
                          <span>{row}</span>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          {typeof s.scarcityPercent === "number" && s.scarcityPercent > 0 && (
            <div style={{ marginTop: 22, maxWidth: 420, margin: "22px auto 0" }}>
              <div
                style={{
                  height: 8,
                  borderRadius: 999,
                  background: b.onDark
                    ? "rgba(255,255,255,0.18)"
                    : "rgba(0,0,0,0.09)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, Math.max(0, s.scarcityPercent))}%`,
                    height: "100%",
                    background: accent,
                  }}
                />
              </div>
              <p
                style={{
                  margin: "8px 0 0",
                  fontSize: 12.5,
                  textAlign: "center",
                  color: muted,
                }}
              >
                {Math.round(s.scarcityPercent)}% claimed
              </p>
            </div>
          )}
          {s.compareAt && (
            <p
              style={{
                margin: "14px 0 0",
                fontSize: 13,
                textAlign: "center",
                color: muted,
              }}
            >
              {s.compareAt}
            </p>
          )}
          {ctx.ctaHref && (
            <Cta
              href={ctx.ctaHref}
              label={s.ctaLabel || ctx.defaultCta}
              bg={btnBg}
              fg={btnFg}
              subtitle={ctx.ctaSubtitle}
            />
          )}
        </section>
      );

    default:
      return null;
  }
}

function H2({
  children,
  t,
  align,
}: {
  children: React.ReactNode;
  t: TypeScale;
  align?: "left" | "center";
}) {
  return (
    // fnlH2 draws a short accent rule under the heading (CSS ::after driven
    // by --fnl-accent) — the small typographic kicker that separates sections
    // visually without another border or box.
    <h2
      className={align === "left" ? "fnlH2 fnlH2L" : "fnlH2"}
      style={{
        margin: "0 0 20px",
        fontSize: t.h2,
        lineHeight: 1.12,
        fontWeight: t.weight,
        letterSpacing: t.tracking,
        textTransform: t.transform,
        fontFamily: t.headingStack,
        textAlign: align ?? "center",
        color: "inherit",
      }}
    >
      {children}
    </h2>
  );
}

function Lede({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <p
      style={{
        margin: "-8px auto 20px",
        maxWidth: 520,
        fontSize: 15.5,
        lineHeight: 1.6,
        textAlign: "center",
        color,
      }}
    >
      {children}
    </p>
  );
}

function Cta({
  href,
  label,
  bg,
  fg,
  subtitle,
}: {
  href: string;
  label: string;
  bg: string;
  fg: string;
  subtitle?: string;
}) {
  return (
    <div style={{ marginTop: 30, textAlign: "center" }}>
      <a
        href={href}
        className="fnlBtn"
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: subtitle ? "14px 38px" : "16px 38px",
          borderRadius: 12,
          // Top-light sheen over the solid colour — reads as a physical
          // button rather than a filled rectangle.
          background: `linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0) 55%), ${bg}`,
          color: fg,
          textDecoration: "none",
          // The FHL treatment: the button glows in its own colour. `bg` is
          // always a hex here, so hex-alpha suffixes are safe.
          boxShadow: `0 0 38px -6px ${bg}99, 0 12px 30px -12px rgba(0,0,0,0.5)`,
        }}
      >
        <span style={{ fontSize: 17.5, fontWeight: 800, letterSpacing: "0.01em" }}>
          {label}
        </span>
        {subtitle && (
          <span style={{ marginTop: 3, fontSize: 12.5, opacity: 0.85 }}>
            {subtitle}
          </span>
        )}
      </a>
    </div>
  );
}
