import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isValidSessionId } from "@/lib/comms/web-chat/session";
import { isDocId } from "@/lib/server/doc-id";

export const dynamic = "force-dynamic";

/**
 * Visitor-side delivery poll. The widget calls this every few seconds while
 * the chat is open to pick up OUTBOUND messages it doesn't already have —
 * specifically an operator's live-takeover reply (or an approved suggest-mode
 * draft) sent from the unified inbox, which has no other way to reach the
 * visitor's iframe.
 *
 * Anonymous by design, exactly like /message + /capture: the iframe lives on
 * LeadStack's domain so an Origin check is useless (see /message's comment).
 * The unguessable session id IS the credential — it only ever exposes that
 * one session's own transcript, which the visitor already sees. Read-only, so
 * no token-budget/rate concerns beyond a bounded query.
 */

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function GET(request: Request) {
  const headers = corsHeaders(request.headers.get("origin"));
  const url = new URL(request.url);
  const subAccountId = url.searchParams.get("sa")?.trim();
  const sessionId = url.searchParams.get("sessionId")?.trim();
  const afterMs = Number(url.searchParams.get("after") ?? "0") || 0;

  if (!subAccountId || !isDocId(subAccountId) || !isValidSessionId(sessionId)) {
    return NextResponse.json(
      { messages: [], serverNowMs: Date.now() },
      { status: 200, headers },
    );
  }

  try {
    // Range on a single field (createdAt) — served by the automatic
    // single-field index, no composite needed. Direction is filtered in
    // memory so we never need a compound index.
    const snap = await getAdminDb()
      .doc(`subAccounts/${subAccountId}/webChatSessions/${sessionId}`)
      .collection("messages")
      .where("createdAt", ">", Timestamp.fromMillis(afterMs))
      .orderBy("createdAt", "asc")
      .limit(50)
      .get();

    const messages = snap.docs
      .map((d) => {
        const data = d.data() as {
          direction?: string;
          body?: string;
          createdAt?: { toMillis?: () => number };
        };
        return {
          id: d.id,
          direction: data.direction ?? "outbound",
          body: data.body ?? "",
          createdAtMs:
            typeof data.createdAt?.toMillis === "function"
              ? data.createdAt.toMillis()
              : 0,
        };
      })
      // Visitors already see their own inbound turns; only surface replies.
      .filter((m) => m.direction === "outbound" && m.body);

    return NextResponse.json(
      {
        messages: messages.map((m) => ({
          id: m.id,
          body: m.body,
          createdAtMs: m.createdAtMs,
        })),
        serverNowMs: Date.now(),
      },
      { status: 200, headers },
    );
  } catch (err) {
    console.warn(
      `[web-chat/poll] sa=${subAccountId} session=${sessionId} failed`,
      err,
    );
    return NextResponse.json(
      { messages: [], serverNowMs: Date.now() },
      { status: 200, headers },
    );
  }
}
