import { TRAFFIC_LIGHT, trafficLight } from "@/lib/prospecting/report-story";

/**
 * The ring's traffic-light colour and geometry, shared with the preview image
 * (R4), which draws the same ring in Satori and cannot use the Tailwind classes.
 */
export function ringGeometry(score: number, size: number) {
  const { color } = TRAFFIC_LIGHT[trafficLight(score)];
  const stroke = size / 10;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));
  return { color, stroke, r, circumference, clamped };
}

/**
 * A section's score as an inline SVG ring in its traffic-light colour.
 * Server-rendered, no chart library and no hooks: the public report page is
 * a server component (a client import crashed it once, #293). The preview
 * image (R4) reuses it.
 *
 * The visible "/100" is screen-reader text only: the aria-label on the
 * wrapper already reads "<label>: 30 out of 100".
 */
export function ScoreRing({
  score,
  label,
  size = 44,
}: {
  score: number;
  label: string;
  size?: number;
}) {
  const { color, stroke, r, circumference, clamped } = ringGeometry(score, size);
  return (
    <div
      role="img"
      aria-label={`${label}: ${score} out of 100`}
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#E5E7EB"
          strokeWidth={stroke}
        />
        {clamped > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
          />
        ) : null}
      </svg>
      <span
        className="text-foreground absolute font-semibold tabular-nums"
        style={{ fontSize: size * 0.28 }}
      >
        {score}
        <span className="sr-only">/100</span>
      </span>
    </div>
  );
}

/** "Good" / "Needs work" / "Poor", in the fixed traffic-light colour. */
export function StatusPill({ score }: { score: number }) {
  const { color, label } = TRAFFIC_LIGHT[trafficLight(score)];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ color, borderColor: color }}
    >
      {label}
    </span>
  );
}
