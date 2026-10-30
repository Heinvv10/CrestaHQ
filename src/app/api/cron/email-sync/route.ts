import "server-only";
import { NextResponse } from "next/server";
import {
  publishCallback,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { anyWorkspaceAllowsImport } from "@/lib/google-calendar/import-state";
import { runAfterResponse } from "@/lib/server/after-response";
import { runMailboxSweep } from "@/lib/server/mailbox-sync";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
const TICK_MS = 15 * 60_000;
/**
 * The scheduled tick (no `after` cursor) also fans out the Google Calendar
 * import sweep (api/cron/calendar-import), which holds no schedule of its
 * own — after the response, so neither its failure nor a slow Firestore
 * read or QStash publish ever touches the mailbox sweep.
 */
async function fanOutCalendarImport(): Promise<void> {
  try {
    if (!(await anyWorkspaceAllowsImport())) return;
    if (
      !(await publishCallback({
        pathname: "/api/cron/calendar-import",
        body: {},
        delaySeconds: 0,
        deduplicationId: `calendar-import-${Math.floor(Date.now() / TICK_MS)}`,
      }))
    )
      console.error("[cron/email-sync] calendar import not queued");
  } catch (err) {
    console.error(
      "[cron/email-sync] calendar import fan-out failed",
      err instanceof Error ? err.message : String(err)
    );
  }
}
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
  if (after === undefined) runAfterResponse(fanOutCalendarImport);
  try {
    const result = await runMailboxSweep(after);
    // publishCallback never throws: null means "not queued" (e.g. the daily
    // cap). The next scheduled sweep picks the remaining mailboxes up.
    if (
      result.hasMore &&
      !(await publishCallback({
        pathname: "/api/cron/email-sync",
        body: { after: result.nextAfter },
        delaySeconds: 1,
        deduplicationId: `email-sync-${result.nextAfter}-${Math.floor(Date.now() / 60000)}`,
      }))
    )
      console.error(
        `[cron/email-sync] continuation not queued after=${result.nextAfter}`
      );
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Mailbox sweep failed" },
      { status: 500 }
    );
  }
}
