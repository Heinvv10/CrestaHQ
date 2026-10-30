import "server-only";

import { NextResponse } from "next/server";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import {
  Webinar1ConnectionError,
  getWebinar1Client,
} from "@/lib/webinar1/client";
import { webinar1GateOffResponse, webinar1GateOn } from "@/lib/webinar1/gate";

/**
 * Proxy to the connected Webinar1 deployment — the browser never sees the
 * API key, so every call round-trips through here.
 *
 * GET  — list the workspace's webinars.
 * POST — create a webinar (title + slug required; slug 409s surface as-is).
 */

export const dynamic = "force-dynamic";

function connectionErrorResponse(err: unknown): NextResponse {
  if (err instanceof Webinar1ConnectionError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.code === "not_connected" ? 409 : (err.status ?? 502) }
    );
  }
  console.error("[webinar1] proxy failed", err);
  return NextResponse.json({ error: "Request failed" }, { status: 500 });
}

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
    const webinars = await client.listWebinars();
    return NextResponse.json({ webinars });
  } catch (err) {
    return connectionErrorResponse(err);
  }
}

interface CreateBody {
  title?: string;
  slug?: string;
  videoId?: string | null;
  scheduleMode?: string;
  description?: string;
  ctaLabel?: string;
  ctaUrl?: string;
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  // Creating a webinar publishes a page on the connected deployment — admin
  // only, unlike the read/register paths.
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!(await webinar1GateOn(subAccountId))) return webinar1GateOffResponse();

  const body = (await request.json().catch(() => null)) as CreateBody | null;
  const title = body?.title?.trim() ?? "";
  const slug = body?.slug?.trim() ?? "";
  if (!title || !slug) {
    return NextResponse.json(
      { error: "title and slug are required" },
      { status: 400 }
    );
  }

  try {
    const { client } = await getWebinar1Client(subAccountId);
    const webinar = await client.createWebinar({
      title,
      slug,
      videoId: body?.videoId || null,
      scheduleMode: body?.scheduleMode,
      description: body?.description,
      ctaLabel: body?.ctaLabel,
      ctaUrl: body?.ctaUrl,
    });
    return NextResponse.json({ webinar }, { status: 201 });
  } catch (err) {
    return connectionErrorResponse(err);
  }
}
