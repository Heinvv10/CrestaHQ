import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { AiEditError, draftFunnelEditOps } from "@/lib/funnels/ai-edit";
import type { AiEditPageState } from "@/lib/funnels/ai-edit-apply";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * AI funnel editing (Labs) — takes the builder's CURRENT form state plus an
 * instruction, returns operations. Writes nothing; the builder applies the
 * ops locally, the operator reviews, and the save-time sanitizer validates
 * whatever survives review. Same contract as the wand's draft route.
 *
 * Same two gates as the wand (the Watchdog precedent): Labs for the surface,
 * AI Suite because this spends the agency's OpenRouter credits.
 */

interface Body {
  instruction?: string;
  state?: AiEditPageState;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const sub = subSnap.data() ?? {};
  if (sub.labsEnabledByAgency !== true) {
    return NextResponse.json(
      { error: "Labs isn't enabled for this workspace." },
      { status: 403 },
    );
  }
  if (sub.aiSuiteEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "AI features are switched off for this workspace. Ask your agency to enable the AI Suite, or edit the sections manually.",
      },
      { status: 403 },
    );
  }

  if (!body.state || !Array.isArray(body.state.sections)) {
    return NextResponse.json({ error: "Missing page state." }, { status: 400 });
  }

  try {
    const result = await draftFunnelEditOps({
      instruction: (body.instruction ?? "").slice(0, 1_000),
      state: body.state,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AiEditError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[funnels/edit-draft] failed", err);
    return NextResponse.json(
      { error: "Couldn't apply the edit. Try again." },
      { status: 500 },
    );
  }
}
