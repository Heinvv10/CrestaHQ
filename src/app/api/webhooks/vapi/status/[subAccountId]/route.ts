import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { vapiWebhookAuthorized } from "@/lib/comms/voice/webhook-auth";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import { isDocId } from "@/lib/server/doc-id";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Vapi status webhook. Receives lifecycle events: status-update,
 * speech-update, transfer-destination-request, hang, etc. v1 only
 * persists the headline state (callStarted, callEnded, failed) onto
 * the in-flight `voiceCalls/{callId}` doc so the operator console
 * can later render a "live call" indicator. Anything else is
 * acknowledged + ignored.
 *
 * End-of-call analysis is handled separately by the dedicated
 * /end-of-call endpoint — keeping the two split means a slow
 * analysis pass can't block status updates and vice versa.
 */

interface VapiStatusMessage {
  message?: {
    type?: string;
    status?: string;
    call?: { id?: string };
  };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string }> },
) {
  if (!vapiWebhookAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { subAccountId } = await ctx.params;

  // A status update is a few KB; 1 MiB is generous and still bounded.
  const read = await readJsonCapped(request, 1024 * 1024);
  if (!read.ok) {
    if (read.reason === "too_large") {
      console.warn(`[vapi/status] 413: body over the cap sa=${subAccountId} content-length=${request.headers.get("content-length")?.slice(0, 20) ?? "none"}`);
    }
    return read.reason === "too_large"
      ? NextResponse.json({ error: "Request body too large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = (read.value ?? {}) as VapiStatusMessage;

  const message = body.message ?? {};
  if (message.type !== "status-update") {
    return NextResponse.json({ ok: true, ignored: message.type ?? "unknown" });
  }

  const callId = message.call?.id;
  const status = message.status;
  if (!callId || !status) {
    return NextResponse.json({ ok: true, ignored: "missing call.id or status" });
  }
  // Both become a doc path; a non-doc id would address something else.
  if (!isDocId(subAccountId) || !isDocId(callId)) {
    return NextResponse.json({ ok: true, ignored: "invalid id" });
  }

  try {
    await getAdminDb()
      .doc(`subAccounts/${subAccountId}/voiceCalls/${callId}`)
      .set(
        {
          subAccountId,
          callId,
          liveStatus: status,
          liveStatusAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn(
      `[vapi/status] write failed sa=${subAccountId} call=${callId}`,
      err,
    );
  }

  return NextResponse.json({ ok: true });
}
