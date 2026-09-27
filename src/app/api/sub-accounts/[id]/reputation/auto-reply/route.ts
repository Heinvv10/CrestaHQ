import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin, requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { allListings, isMain, locationNamesOf, type ListingFields } from "@/lib/gbp/listings";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { heldByAnotherSubAccount } from "@/lib/gbp/shared-location";
import { toMillis } from "@/lib/gbp/sync/types";
import {
  AUTO_REPLY_DAILY_DRAFT_CAP,
  AUTO_REPLY_DAILY_POST_CAP,
  AUTO_REPLY_ENGINE_AVAILABLE,
  extraListingWrites,
  listingOn,
  nextAutoReplySettings,
  parseAutoReplyBody,
  readAutoReplyListings,
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
 *
 * Per listing (MULTI_LISTING_V1_PLAN.md PR 6): `enabled` stays the MAIN
 * listing's switch. The PUT may also carry `listings: {locationName: on}`
 * for EXTRA listings — each switched ON must be one of this sub-account's
 * connected extras (else 400 `unknown_listing`; an off for a listing no
 * longer connected is dropped); switching one off→on takes the same gates
 * and refusals as the main one, `listing_shared` asked of THAT listing, and
 * stamps its own `enabledAt` / `enabledByUid` in
 * `reviewsAutoReply.extraListings.{locId}` (an extra already on is kept as
 * it is, unchecked); off deletes the key; a listing left out keeps its
 * state. Any off→on clears main's `disabledReason`. Modes, backlog and the daily caps are shared.
 * GET and PUT also answer `listings: [{locationName, title, main, enabled,
 * enabledAt}]`, main first.
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

/** The settings as the card sees them, with one row per connected listing (main first) and whether it is on. */
function view(raw: unknown, sub: Sub) {
  const at = toMillis((raw as { enabledAt?: unknown } | null | undefined)?.enabledAt);
  const settings = readAutoReplySettings(raw);
  const on = readAutoReplyListings(raw, sub as ListingFields);
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    ...settings,
    enabledAt: iso(at),
    disabledReason: readDisabledReason(raw),
    listings: allListings(sub as ListingFields).map((l) => {
      const main = isMain(sub as ListingFields, l.locationName);
      const entry = listingOn(on, l.locationName);
      return {
        locationName: l.locationName, title: l.title, main,
        // Main: the master switch as stored. Extra: its own switch.
        enabled: main ? settings.enabled : entry !== null,
        enabledAt: main ? iso(at) : iso(entry?.enabledAtMs ?? null),
      };
    }),
  };
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;
  const sub = (await getAdminDb().doc(`subAccounts/${id}`).get()).data() ?? {};
  const gate = gateOff(sub);
  return NextResponse.json({
    ...view(sub.reviewsAutoReply, sub),
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
  if ((input.enabled || Object.values(input.listings ?? {}).includes(true)) && !AUTO_REPLY_ENGINE_AVAILABLE) {
    return gbpRefusal(409, "not_available", "Review auto-reply is not available yet.");
  }

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${id}`);
  const outcome = await db.runTransaction(async (tx) => {
    const sub = ((await tx.get(ref)).data() ?? {}) as Sub;
    const prev = sub.reviewsAutoReply as Record<string, unknown> | undefined;
    const connected = locationNamesOf(sub as ListingFields);
    // Switching off is always allowed: an off for a listing no longer connected
    // (a card still showing a removed extra) is dropped, not refused.
    const listings = Object.fromEntries(Object.entries(input.listings ?? {}).filter(([loc, on]) => on || connected.includes(loc)));
    const extras = connected.filter((l) => !isMain(sub as ListingFields, l));
    if (Object.keys(listings).some((loc) => !extras.includes(loc))) {
      return gbpRefusal(400, "unknown_listing", "Auto-reply can be switched per listing only for this sub-account's additional listings.");
    }
    const was = readAutoReplyListings(prev, sub as ListingFields);
    // Only an extra switching OFF→ON is checked; one already on stays as it is
    // (the engine pauses it while it is shared).
    const extrasTurningOn = Object.keys(listings).filter((loc) => listings[loc] && !listingOn(was, loc));
    const turningOnExtra = extrasTurningOn.length > 0;
    if (input.enabled || turningOnExtra) {
      const refused = gateRefusal(sub);
      if (refused) return refused;
      // Switching it ON while it could not post (and the reconnect alert, sent
      // only while it is on, already went unsent) would stall silently.
      const meta = sub.googleConnectionMeta as { reconnectRequired?: unknown } | null | undefined;
      const turningOnMain = input.enabled && prev?.enabled !== true;
      if ((turningOnMain || turningOnExtra) && meta?.reconnectRequired === true) {
        return gbpRefusal(409, "reconnect_required", "Reconnect Google before turning auto-reply on.");
      }
    }
    const listing = (sub.googleListing as { locationName?: unknown } | null | undefined)?.locationName;
    // Each listing it would be on for: no other sub-account may manage it (H1, per listing).
    const shared = [...(input.enabled && typeof listing === "string" && listing ? [listing] : []), ...extrasTurningOn];
    for (const loc of shared) {
      if (await heldByAnotherSubAccount(db, tx, loc, id)) {
        return gbpRefusal(409, "listing_shared", "Another sub-account uses this Google listing — auto-reply can't be switched on here.");
      }
    }
    const now = new Date();
    const next = nextAutoReplySettings(prev, input, {
      now,
      uid: access.uid,
      listingLocationName: typeof listing === "string" && listing ? listing : null,
      extraTurningOn: turningOnExtra,
    });
    if (!next.ok) return gbpRefusal(409, next.code, "Choose a Google Business listing before turning auto-reply on.");
    const writes = extraListingWrites(prev, sub as ListingFields, listings, { now, uid: access.uid });
    const extraListings = Object.fromEntries(
      Object.entries(writes).map(([k, v]) => [k, v ?? FieldValue.delete()]),
    );
    // Merged: an extra listing's switch not in this body keeps its state.
    tx.set(ref, { reviewsAutoReply: { ...next.value, ...(Object.keys(writes).length ? { extraListings } : {}) } }, { merge: true });
    const kept = { ...((prev?.extraListings ?? {}) as Record<string, unknown>) };
    for (const [k, v] of Object.entries(writes)) {
      if (v) kept[k] = v;
      else delete kept[k];
    }
    return { ...sub, reviewsAutoReply: { ...next.value, extraListings: kept } } as Sub;
  });
  if (outcome instanceof NextResponse) return outcome;
  return NextResponse.json({ reviewsAutoReply: view(outcome.reviewsAutoReply, outcome) });
}
