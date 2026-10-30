// Stub — see publish/README.md. The real component renders the ticking
// DD:HH:MM:SS block for the LeadStack landing's countdown deal. The
// shipped-but-dormant agency Deal editor imports it, so the export shape
// must survive for the buyer build to compile.
import type { CountdownParts } from "@/hooks/use-deal-urgency";

export function DealCountdown(_props: {
  parts: CountdownParts;
  size?: "sm" | "md";
  className?: string;
}) {
  return null;
}

export function formatCountdownShort(_parts: CountdownParts): string {
  return "";
}
