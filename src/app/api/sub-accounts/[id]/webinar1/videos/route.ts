import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  Webinar1ConnectionError,
  getWebinar1Client,
} from "@/lib/webinar1/client";
import { webinar1GateOffResponse, webinar1GateOn } from "@/lib/webinar1/gate";

/** List videos on the connected Webinar1 deployment (for the create-webinar
 *  picker). Videos are uploaded in Webinar1's own admin — there's no
 *  upload-by-URL on the platform, so this is read-only by design. */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!(await webinar1GateOn(subAccountId))) return webinar1GateOffResponse();

  try {
    const { client } = await getWebinar1Client(subAccountId);
    const videos = await client.listVideos();
    return NextResponse.json({ videos });
  } catch (err) {
    if (err instanceof Webinar1ConnectionError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "not_connected" ? 409 : (err.status ?? 502) }
      );
    }
    console.error("[webinar1] videos proxy failed", err);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
}
