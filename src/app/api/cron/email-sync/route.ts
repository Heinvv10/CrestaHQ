import "server-only";
import { NextResponse } from "next/server";
import {
  publishCallback,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { runMailboxSweep } from "@/lib/server/mailbox-sync";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature"),
    raw = await request.text();
  if (!signature || !(await verifyQStashSignature(signature, raw)))
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  let after: string | undefined;
  try {
    const body = JSON.parse(raw || "{}");
    if (typeof body.after === "string" && /^[^/]{1,150}$/.test(body.after))
      after = body.after;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const result = await runMailboxSweep(after);
    if (result.hasMore)
      await publishCallback({
        pathname: "/api/cron/email-sync",
        body: { after: result.nextAfter },
        delaySeconds: 1,
        deduplicationId: `email-sync-${result.nextAfter}-${Math.floor(Date.now() / 60000)}`,
      });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Mailbox sweep failed" },
      { status: 500 }
    );
  }
}
