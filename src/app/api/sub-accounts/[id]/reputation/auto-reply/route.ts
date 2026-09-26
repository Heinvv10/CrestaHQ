import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin, requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { toMillis } from "@/lib/gbp/sync/types";
import {
  AUTO_REPLY_DAILY_DRAFT_CAP,
  AUTO_REPLY_DAILY_POST_CAP,
  AUTO_REPLY_ENGINE_AVAILABLE,
  nextAutoReplySettings,
  parseAutoReplyBody,
  readAutoReplySettings,
} from "@/lib/reputation/auto-reply/settings";

/**
 * GET → `{enabled, modes, includeBacklog, enabledAt, gatesOn, available,
 * dailyPostCap, dailyDraftCap}` for any member: the saved review auto-reply
 * settings (defaults when absent), whether all three agency gates are on,
 * whether this deployment's engine can act on them, and the daily caps.
 *
 * PUT `{enabled, modes: {1..5: "auto"|"approval"}, includeBacklog}` —
 * sub-account admin; any other key or a missing star is 400 `invalid_body`.
 * Turning it on needs the engine (409 `not_available`), the Google gate
 * (403 `gate_off`), the Reviews AI gate (403 `ai_gate_off`), the auto-reply
 * gate (403 `auto_reply_gate_off`) and a selected listing (409 `no_listing`);
 * turning it off is always allowed. The server stamps `enabledAt`,
 * `enabledByUid` and `listingLocationName` on the off→on transition, inside
 * a transaction. See AUTO_REPLY_V1_PLAN.md.
 */

export const dynamic = "force-dynamic";

type Sub = Record<string, unknown>;

function gateRefusal(sub: Sub): NextResponse | null {
  if (sub.googleEnabledByAgency !== true) {
    return gbpRefusal(403, "gate_off", "Google Business Profile is locked by your agency.");
  }
  if (sub.reviewsAiEnabledByAgency !== true) {
    return gbpRefusal(403, "ai_gate_off", "Reviews AI is not enabled for this sub-account.");
  }
  if (sub.reviewsAutoReplyEnabledByAgency !== true) {
    return gbpRefusal(403, "auto_reply_gate_off", "Review auto-reply is not enabled for this sub-account.");
  }
  return null;
}

function view(raw: unknown) {
  const at = toMillis((raw as { enabledAt?: unknown } | null | undefined)?.enabledAt);
  return { ...readAutoReplySettings(raw), enabledAt: at === null ? null : new Date(at).toISOString() };
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;
  const sub = (await getAdminDb().doc(`subAccounts/${id}`).get()).data() ?? {};
  return NextResponse.json({
    ...view(sub.reviewsAutoReply),
    gatesOn: gateRefusal(sub) === null,
    available: AUTO_REPLY_ENGINE_AVAILABLE,
    dailyPostCap: AUTO_REPLY_DAILY_POST_CAP,
    dailyDraftCap: AUTO_REPLY_DAILY_DRAFT_CAP,
  });
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountAdmin(request, id);
  if (access instanceof NextResponse) return access;

  const input = parseAutoReplyBody(await request.json().catch(() => null));
  if (!input) {
    return gbpRefusal(400, "invalid_body", "Send enabled, includeBacklog and a mode (auto or approval) for every star 1–5.");
  }
  if (input.enabled && !AUTO_REPLY_ENGINE_AVAILABLE) {
    return gbpRefusal(409, "not_available", "Review auto-reply is not available yet.");
  }

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${id}`);
  const outcome = await db.runTransaction(async (tx) => {
    const sub = ((await tx.get(ref)).data() ?? {}) as Sub;
    if (input.enabled) {
      const refused = gateRefusal(sub);
      if (refused) return refused;
    }
    const listing = (sub.googleListing as { locationName?: unknown } | null | undefined)?.locationName;
    const next = nextAutoReplySettings(sub.reviewsAutoReply, input, {
      now: new Date(),
      uid: access.uid,
      listingLocationName: typeof listing === "string" && listing ? listing : null,
    });
    if (!next.ok) return gbpRefusal(409, next.code, "Choose a Google Business listing before turning auto-reply on.");
    tx.set(ref, { reviewsAutoReply: next.value }, { merge: true });
    return next.value;
  });
  if (outcome instanceof NextResponse) return outcome;
  return NextResponse.json({ reviewsAutoReply: view(outcome) });
}
