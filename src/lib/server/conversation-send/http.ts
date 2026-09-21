import { NextResponse } from "next/server";
import type { SendOutcome } from "./types";

/**
 * A send outcome as the manual send routes have always answered it: the
 * success body verbatim, or `{ error }` / `{ error, code }` with the refusal's
 * status. Key order matches the pre-extraction responses.
 */
export function sendOutcomeResponse(outcome: SendOutcome): NextResponse {
  if (outcome.ok) return NextResponse.json(outcome.response);
  return NextResponse.json(
    outcome.code === undefined
      ? { error: outcome.error }
      : { error: outcome.error, code: outcome.code },
    { status: outcome.status },
  );
}
