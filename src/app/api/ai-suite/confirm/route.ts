import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny, requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import {
  CapabilityUserError,
  getCapability,
  roleSatisfies,
  type AiSuiteActionContext,
} from "@/lib/ai-suite/capabilities";
import { recordAiSuiteAction } from "@/lib/ai-suite/audit";
import { recordAiSuiteUsage } from "@/lib/ai-suite/usage";
import type { AiSuiteConfirmRequest } from "@/types/ai-suite";

export const dynamic = "force-dynamic";

/**
 * Execute a previously-proposed AI Suite action, after the user confirmed it.
 *
 * This is the single place a write happens. It re-authenticates the caller,
 * re-checks the capability's required role, re-validates the args, and only
 * then runs the handler — none of which trusts the model or the client
 * beyond the whitelisted capability + validated args. Tenant scope
 * (subAccountId / agencyId) comes from the authenticated session, so a
 * crafted request can never exceed the caller's own permissions or reach
 * another tenant.
 */
export async function POST(request: Request) {
  let body: AiSuiteConfirmRequest;
  try {
    body = (await request.json()) as AiSuiteConfirmRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const level = body.level;
  if (level !== "agency" && level !== "sub-account") {
    return NextResponse.json(
      { error: "`level` must be 'agency' or 'sub-account'." },
      { status: 400 },
    );
  }

  // Readonly lookups execute inline in the chat route — they're not
  // confirmable actions, so this endpoint refuses them.
  const cap = getCapability(body.capability);
  if (!cap || cap.level !== level || cap.readonly) {
    return NextResponse.json(
      { error: "Unknown or unavailable action." },
      { status: 400 },
    );
  }

  // ── Auth + role + (sub-account) gate. Everything the handler runs with is
  // derived from here, never from the request body.
  let ctx: AiSuiteActionContext;
  if (level === "sub-account") {
    if (!body.subAccountId || typeof body.subAccountId !== "string") {
      return NextResponse.json(
        { error: "`subAccountId` is required for sub-account level." },
        { status: 400 },
      );
    }
    const access = await requireSubAccountMember(request, body.subAccountId);
    if (access instanceof NextResponse) return access;

    const subSnap = await getAdminDb()
      .doc(`subAccounts/${body.subAccountId}`)
      .get();
    // Opt-in gate: the Workspace Assistant is OFF unless the agency owner
    // explicitly enabled it for this sub-account (legacy/unset reads as off).
    if (subSnap.data()?.aiSuiteEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "The AI Suite is disabled for this sub-account. Ask your agency owner to enable it.",
        },
        { status: 403 },
      );
    }

    if (
      !roleSatisfies(cap.requiredRole, {
        agencyRoleIsOwner: access.subAccountRole === "agencyOwner",
        subAccountRole: access.subAccountRole,
      })
    ) {
      return NextResponse.json(
        { error: "You don't have permission to perform this action." },
        { status: 403 },
      );
    }

    ctx = {
      uid: access.uid,
      email: access.email,
      displayName: "",
      agencyId: access.agencyId ?? "",
      subAccountId: body.subAccountId,
      subAccountRole: access.subAccountRole,
    };
  } else {
    const owner = await requireAgencyOwnerAny(request);
    if (owner instanceof NextResponse) return owner;
    // Master switch: mirrors the chat route so a stale proposal can't execute
    // after the assistant was turned off.
    const agencySnap = await getAdminDb()
      .doc(`agencies/${owner.agencyId}`)
      .get();
    if (agencySnap.data()?.agencyAssistantEnabled !== true) {
      return NextResponse.json(
        {
          error:
            "The Agency Assistant is turned off. Enable it under Agency → Settings.",
        },
        { status: 403 },
      );
    }
    if (!roleSatisfies(cap.requiredRole, { agencyRoleIsOwner: true })) {
      return NextResponse.json(
        { error: "You don't have permission to perform this action." },
        { status: 403 },
      );
    }
    // displayName is cosmetic (member list); fetch it to match UI-created
    // sub-accounts rather than leaving it blank.
    let displayName = "";
    try {
      const record = await getAdminAuth().getUser(owner.uid);
      displayName = record.displayName ?? "";
    } catch {
      /* non-fatal */
    }
    ctx = {
      uid: owner.uid,
      email: owner.email,
      displayName,
      agencyId: owner.agencyId ?? "",
    };
  }

  // Re-validate the args server-side — the client's payload is never trusted.
  const validated = cap.validate(body.args);
  if (!validated.ok) {
    return NextResponse.json(
      { error: `Can't run that action: ${validated.error}.` },
      { status: 400 },
    );
  }

  const summary = cap.summarize(validated.args);

  try {
    const result = await cap.execute(ctx, validated.args);
    await recordAiSuiteAction({
      level,
      capability: cap.name,
      args: validated.args,
      summary,
      status: "executed",
      agencyId: ctx.agencyId,
      subAccountId: ctx.subAccountId ?? null,
      confirmedByUid: ctx.uid,
      confirmedByEmail: ctx.email,
      resultRef: result.ref ?? null,
    });
    void recordAiSuiteUsage({
      level,
      agencyId: ctx.agencyId,
      subAccountId: ctx.subAccountId,
      kind: "action",
    });
    return NextResponse.json({ ok: true, resultText: result.resultText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[ai-suite/confirm] ${cap.name} failed:`, msg);
    await recordAiSuiteAction({
      level,
      capability: cap.name,
      args: validated.args,
      summary,
      status: "failed",
      agencyId: ctx.agencyId,
      subAccountId: ctx.subAccountId ?? null,
      confirmedByUid: ctx.uid,
      confirmedByEmail: ctx.email,
      error: msg.slice(0, 500),
    });
    // User-facing failures (gate off, record not in this tenant, …) are
    // surfaced verbatim; anything unexpected stays generic.
    if (err instanceof CapabilityUserError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "The action failed to run. Please try again." },
      { status: 500 },
    );
  }
}
