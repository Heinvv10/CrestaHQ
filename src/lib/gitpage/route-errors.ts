import "server-only";

import { NextResponse } from "next/server";
import { cleanText, GitpageError } from "@/lib/gitpage/client";
import { markGitpageKeyInvalid } from "@/lib/gitpage/heartbeat";

/**
 * A gitpage failure as the browser sees it from the template routes
 * (hardening, not upstream): gitpage's message only, cleaned and capped —
 * never its body. 401 / 403 are about the agency's gitpage key, not the
 * caller's session, so they answer 502 (and a 401 flags the key, as a build
 * does); 5xx is 502; any other error is fixed text.
 */
export async function gitpageErrorResponse(err: unknown, fallback: string): Promise<NextResponse> {
  if (err instanceof GitpageError) {
    if (err.status === 401) await markGitpageKeyInvalid();
    const passThrough = err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403;
    return NextResponse.json(
      { error: cleanText(err.message, 500) ?? fallback },
      { status: passThrough ? err.status : 502 },
    );
  }
  const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  console.error(`[website/templates] gitpage request failed: ${err instanceof Error ? err.message : String(err)}`);
  return NextResponse.json(
    { error: timedOut ? "gitpage didn't answer in time — please try again." : fallback },
    { status: 502 },
  );
}
