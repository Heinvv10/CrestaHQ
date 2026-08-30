import { LANDING_VARIANT } from "@/config/landing";

/**
 * Default brand glyph, switched by deployment mode:
 *
 *   - "leadstack" (demo/template mode) — the LeadStack "Chevron Stack":
 *     three offset chevron-tipped bars alternating direction.
 *   - "custom" (buyer deployments) — the neutral green "my CRM" badge
 *     (emerald→teal gradient "CRM" on a dark rounded square, matching the
 *     custom landing palette + the default PWA app icon), so no LeadStack
 *     branding ever leaks to a buyer's clients. Buyers replace it with
 *     their own logo via the agency Branding settings (logoUrl).
 *
 * Use `<LogoMark size={20} />` next to the wordmark, or alone as a glyph.
 */

interface LogoMarkProps {
  /** Square pixel size. Defaults to 20 (matches sidebar usage). */
  size?: number;
  className?: string;
  /** Optional unique suffix when multiple instances render in one document — keeps the gradient defs from colliding across SSR + hydration. */
  idSuffix?: string;
}

export function LogoMark(props: LogoMarkProps) {
  if (LANDING_VARIANT === "custom") return <MyCrmMark {...props} />;
  return <ChevronStackMark {...props} />;
}

/** Neutral buyer-default badge — mirrors scripts/pwa-default-icon.svg. */
function MyCrmMark({ size = 20, className, idSuffix = "" }: LogoMarkProps) {
  const gradId = `mycrm-grad${idSuffix}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="55%" stopColor="#2dd4bf" />
          <stop offset="100%" stopColor="#6ee7b8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#18181b" />
      <text
        x="32"
        y="38"
        textAnchor="middle"
        fontFamily="inherit"
        fontWeight="700"
        fontSize="25"
        letterSpacing="0.5"
        fill={`url(#${gradId})`}
      >
        CRM
      </text>
      <rect x="19" y="44" width="26" height="4" rx="2" fill={`url(#${gradId})`} />
    </svg>
  );
}

/**
 * LeadStack "Chevron Stack" — top points left, middle right, bottom left;
 * chevron tips trace an S while alternating alignment reads as stacked
 * cards.
 */
function ChevronStackMark({ size = 20, className, idSuffix = "" }: LogoMarkProps) {
  const id1 = `ls-mark-1${idSuffix}`;
  const id2 = `ls-mark-2${idSuffix}`;
  const id3 = `ls-mark-3${idSuffix}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id1} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id={id2} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <linearGradient id={id3} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#c026d3" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>

      {/* Top chevron — points LEFT, right-aligned */}
      <path d="M 56 8 L 18 8 L 8 16 L 18 24 L 56 24 Z" fill={`url(#${id1})`} />

      {/* Middle chevron — points RIGHT, left-aligned */}
      <path d="M 8 28 L 46 28 L 56 36 L 46 44 L 8 44 Z" fill={`url(#${id2})`} />

      {/* Bottom chevron — points LEFT, right-aligned */}
      <path d="M 56 48 L 18 48 L 8 56 L 18 60 L 56 60 Z" fill={`url(#${id3})`} />
    </svg>
  );
}
