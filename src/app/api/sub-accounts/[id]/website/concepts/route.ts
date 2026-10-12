import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { fetchConcepts, gitpageIsConfigured } from "@/lib/gitpage/client";
import { isNicheKey } from "@/lib/website/niches";
import {
  requireWebsiteEnabledSub,
  WebsiteServiceError,
} from "@/lib/server/websites-service";

export const dynamic = "force-dynamic";

/**
 * Stable machine-readable `code` on every error body, so the picker maps on
 * the code and not on a status that gitpage (or the tenancy helper) chose.
 * `upstream` is the only code for a gitpage failure of any kind.
 */
export type ConceptsErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "gate_off"
  | "not_configured"
  | "bad_niche"
  | "upstream";

function fail(code: ConceptsErrorCode, error: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

const TENANCY_CODES: Record<number, ConceptsErrorCode> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
};

/**
 * GET /api/sub-accounts/[id]/website/concepts?niche=gym_fitness
 *
 * Proxies gitpage's `GET /api/v1/concepts` (the premium "pitch cards" — three
 * studio-style design directions per niche) for the website builder's
 * concept picker. Member-auth; the agency's gitpage key never reaches the
 * browser. `niche` omitted/blank = the generic (no-niche) concepts.
 *
 * Behind the `websiteEnabledByAgency` gate like create and build (upstream
 * has no check here): the call spends the agency's gitpage key, and the
 * picker it feeds is part of a builder the workspace does not have.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) {
    // The tenancy helper's own answers keep their status and gain a code.
    const body = (await access.json().catch(() => ({}))) as { error?: unknown };
    const error = typeof body.error === "string" ? body.error : "Not allowed.";
    const code = TENANCY_CODES[access.status];
    return code ? fail(code, error, access.status) : NextResponse.json({ error }, { status: access.status });
  }

  try {
    await requireWebsiteEnabledSub(subAccountId);
  } catch (err) {
    if (err instanceof WebsiteServiceError) {
      const code: ConceptsErrorCode | undefined =
        err.status === 403 ? "gate_off" : err.status === 404 ? "not_found" : undefined;
      return code
        ? fail(code, err.message, err.status)
        : NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (!gitpageIsConfigured()) {
    return fail("not_configured", "gitpage is not configured on this deployment (GITPAGE_API_KEY missing).", 503);
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("niche");
  const niche = raw && isNicheKey(raw) ? raw : null;
  if (raw && !niche) {
    return fail("bad_niche", "Unknown niche.", 400);
  }

  try {
    const concepts = await fetchConcepts(niche);
    return NextResponse.json(
      { concepts },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch {
    // HARDENING: any gitpage failure (4xx included: a revoked key is 401
    // there, a quota is 429) is OUR 502 with fixed text. Its status and
    // message are never forwarded; they describe the agency's key, not the
    // caller's session.
    return fail("upstream", "The design service is unavailable right now.", 502);
  }
}
