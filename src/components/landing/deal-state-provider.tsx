// Stub — see publish/README.md. The real provider seeds the LeadStack
// landing's price surfaces with server-resolved deal state so the first
// paint can't advertise the deal price and then raise it. The buyer's clone
// renders the custom landing instead, but src/app/page.tsx is a KEPT file
// and imports both exports, so their shapes must survive here.
import type { ReactNode } from "react";

export interface SeededDealState {
  cohort: unknown;
  nowMs: number;
}

export function DealStateProvider({
  children,
}: {
  value: SeededDealState | null;
  children: ReactNode;
}) {
  return children;
}

export function useSeededDealState(): SeededDealState | null {
  return null;
}
