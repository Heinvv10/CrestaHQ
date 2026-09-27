import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin, requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { heldByAnotherSubAccount } from "@/lib/gbp/shared-location";
import { toMillis } from "@/lib/gbp/sync/types";
import {
  AUTO_REPLY_DAILY_DRAFT_CAP,
  AUTO_REPLY_DAILY_POST_CAP,
  AUTO_REPLY_ENGINE_AVAILABLE,
  nextAutoReplySettings,
  parseAutoReplyBody,
  readAutoReplySettings,
  readDisabledReason,
} from "@/lib/reputation/auto-reply/settings";
import { autoReplyKillSwitchOn } from "@/lib/reputation/auto-reply/kill-switch";

/**
 * GET → `{enabled, modes, includeBacklog, enabledAt, disabledReason, gatesOn,
 * gate, available, running, dailyPostCap, dailyDraftCap}` for any member: the
 * saved review auto-reply settings (defaults when absent), why a listing
 * change switched it off (`disabledReason: "listing_changed"`, else null),
 * whether all three agency gates are on and, when not, the FIRST one that is
 * off (`gate`: the PUT's refusal code), whether this deployment's engine can
 * act on them, whether it RUNS here (`running` — the kill switch as a boolean,
 * never its env value), and the daily caps.
 *
 * PUT `{enabled, modes: {1..5: "auto"|"approval"}, includeBacklog}` —
 * sub-account admin; any other key or a missing star is 400 `invalid_body`.
 * Turning it on needs the engine (409 `not_available`), the Google gate
 * (403 `gate_off`), the Reviews AI gate (403 `ai_gate_off`), the auto-reply
 * gate (403 `auto_reply_gate_off`), a selected listing (409 `no_listing`)
 * that no other sub-account has also selected (409 `listing_shared` — the
 * engine cannot see replies cached under another sub-account), and — for
 * the off→on switch only — no pending Google reconnect (409
 * `reconnect_required`: it could not post, and its reconnect alert fires
 * only while it is on); turning it off is always allowed. The server stamps `enabledAt`,
 * `enabledByUid` and `listingLocationName` on the off→on transition, inside
 * a transaction. See AUTO_REPLY_V1_PLAN.md.
 */

export const dynamic = "force-dynamic";

type Sub = Record<string, unknown>;

const GATE_MESSAGES = {
  gate_off: "Google Business Profile is locked by your agency.",
  ai_gate_off: "Reviews AI is not enabled for this sub-account.",
  auto_reply_gate_off: "Review auto-reply is not enabled for this sub-account.",
} as const;

/** The first of the three agency gates that is off, or null when all are on. */
function gateOff(sub: Sub): keyof typeof GATE_MESSAGES | null {
  if (sub.googleEnabledByAgency !== true) return "gate_off";
  if (sub.reviewsAiEnabledByAgency !== true) return "ai_gate_off";
  if (sub.reviewsAutoReplyEnabledByAgency !== true) return "auto_reply_gate_off";
  return null;
}

function gateRefusal(sub: Sub): NextResponse | null {
  const code = gateOff(sub);
  return code ? gbpRefusal(403, code, GATE_MESSAGES[code]) : null;
}

function view(raw: unknown) {
  const at = toMillis((raw as { enabledAt?: unknown } | null | undefined)?.enabledAt);
  return {
    ...readAutoReplySettings(raw),
    enabledAt: at === null ? null : new Date(at).toISOString(),
    disabledReason: readDisabledReason(raw),
  };
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;
  const sub = (await getAdminDb().doc(`subAccounts/${id}`).get()).data() ?? {};
  const gate = gateOff(sub);
  return NextResponse.json({
    ...view(sub.reviewsAutoReply),
    gatesOn: gate === null,
    gate,
    available: AUTO_REPLY_ENGINE_AVAILABLE,
    running: autoReplyKillSwitchOn(),
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
      // Switching it ON while it could not post (and the reconnect alert, sent
      // only while it is on, already went unsent) would stall silently.
      const meta = sub.googleConnectionMeta as { reconnectRequired?: unknown } | null | undefined;
      if ((sub.reviewsAutoReply as { enabled?: unknown } | undefined)?.enabled !== true && meta?.reconnectRequired === true) {
        return gbpRefusal(409, "reconnect_required", "Reconnect Google before turning auto-reply on.");
      }
    }
    const listing = (sub.googleListing as { locationName?: unknown } | null | undefined)?.locationName;
    if (input.enabled && typeof listing === "string" && listing) {
      if (await heldByAnotherSubAccount(db, tx, listing, id)) {
        return gbpRefusal(409, "listing_shared", "Another sub-account uses this Google listing — auto-reply can't be switched on here.");
      }
    }
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
