import "server-only";

import { NextResponse } from "next/server";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { AiDraftError, draftFunnelWithAi } from "@/lib/funnels/ai-draft";
import type { FunnelTemplateKey } from "@/types/funnels";

export const dynamic = "force-dynamic";
// Firecrawl scrape (up to 30s) + an LLM call. Comfortably inside the platform
// cap but well over the default, so it's set explicitly.
export const maxDuration = 60;

/**
 * AI funnel drafter (Labs) — returns DRAFT COPY, writes nothing.
 *
 * The response fills the builder form; the operator reviews and saves. That
 * separation is deliberate: this text goes on a public page under the buyer's
 * brand, so a human sees it before anyone else does.
 *
 * TWO gates, matching the Inbox Watchdog precedent:
 *  - `labsEnabledByAgency` — the Labs surface itself
 *  - `aiSuiteEnabledByAgency` — this spends the AGENCY's OpenRouter credits,
 *    so the agency has to have opted the workspace into AI spend
 */

interface Body {
  description?: string;
  url?: string | null;
  template?: FunnelTemplateKey;
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

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
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
          "AI features are switched off for this workspace. Ask your agency to enable the AI Suite, or fill the form manually.",
      },
      { status: 403 },
    );
  }

  const template: FunnelTemplateKey =
    body.template === "vsl" || body.template === "lead_magnet"
      ? body.template
      : "simple_offer";

  try {
    const draft = await draftFunnelWithAi({
      description: (body.description ?? "").slice(0, 1_000),
      url: (body.url ?? "").slice(0, 300) || null,
      template,
      // Real data beats a model guess — same fallback order the AI website
      // builder uses.
      businessName:
        (sub.name as string | undefined)?.trim() || null,
    });
    return NextResponse.json({ ok: true, draft });
  } catch (err) {
    if (err instanceof AiDraftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[funnels/draft] failed", err);
    return NextResponse.json(
      { error: "Couldn't draft the funnel. Try again." },
      { status: 500 },
    );
  }
}
