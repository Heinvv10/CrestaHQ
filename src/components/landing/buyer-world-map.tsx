// Stub — see publish/README.md. Props typed to match the real component so the
// kept src/app/page.tsx (leadstack branch, dead code for buyer clones) still
// compiles; renders nothing.
import type { BuyerMapData } from "@/lib/landing/buyer-map-data";

export function BuyerWorldMap(_props: {
  eyebrow: string;
  headingLead: string;
  headingEmphasis: string;
  data: BuyerMapData;
  showSavings?: boolean;
  savings?: number;
  preview?: boolean;
}) {
  return null;
}
