// Stub — see publish/README.md. The real hook derives the LeadStack
// landing's urgency state (spots counter / countdown deal). Nothing in the
// buyer's clone renders that landing, but shipped-but-dormant files (the
// agency Deal editor component) import `useCountdown` + `CountdownParts`,
// so the exports must keep their shape for the buyer build to compile.

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function useCountdown(_endsAtMs: number | null): {
  countdown: CountdownParts | null;
  expired: boolean;
} {
  return { countdown: null, expired: false };
}

export function formatDealDeadline(
  _endsAtMs: number,
  _timeZone?: string | null,
): string {
  return "";
}

export function useDealUrgency() {
  return null;
}
