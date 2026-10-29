import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { isDocId } from "@/lib/server/doc-id";
import { redactSlackUrls } from "@/lib/slack/client";
import {
  SlackError,
  connectSlack,
  disconnectSlack,
  getSlackConfig,
  sanitizeSlackEvents,
  updateSlackSettings,
} from "@/lib/server/slack-service";
import { invalidateSlackHookCache } from "@/lib/slack/events";

/**
 * Slack notifications for a sub-account. Admin-only; no agency gate because
 * the client's own channel is the only thing it spends.
 * GET: display meta (never the URL).
 * POST { webhookUrl, channelLabel?, events? }: validate, prove with a test
 * post, store. Re-posting a new URL on a connected card is the reconnect path.
 * PATCH { events?, includeMessagePreview? }: change the ticked events and
 * whether inbound-message posts carry the message text.
 * DELETE: remove the hook and reset the meta.
 */

function fail(err: unknown) {
  if (err instanceof SlackError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[slack] route failed", redactSlackUrls(err instanceof Error ? err.message : String(err)));
  return NextResponse.json({ error: "Slack request failed" }, { status: 500 });
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isDocId(id)) return notFound();
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ config: await getSlackConfig(id) });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isDocId(id)) return notFound();
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if ("events" in body && !Array.isArray(body.events)) {
    return NextResponse.json(
      { error: "events must be an array of event types" },
      { status: 400 },
    );
  }
  if (typeof body.webhookUrl !== "string") {
    return NextResponse.json(
      { error: "webhookUrl is required" },
      { status: 400 },
    );
  }
  try {
    const config = await connectSlack({
      subAccountId: id,
      uid: auth.uid,
      webhookUrl: body.webhookUrl,
      channelLabel:
        typeof body.channelLabel === "string"
          ? body.channelLabel
          : body.channelLabel === null
            ? null
            : undefined,
      events: "events" in body ? sanitizeSlackEvents(body.events) : undefined,
    });
    invalidateSlackHookCache(id);
    return NextResponse.json({ ok: true, config });
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isDocId(id)) return notFound();
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const hasEvents = "events" in body;
  const hasPreview = "includeMessagePreview" in body;
  if ((hasEvents && !Array.isArray(body.events)) || (!hasEvents && !hasPreview)) {
    return NextResponse.json(
      { error: "events must be an array of event types" },
      { status: 400 },
    );
  }
  if (hasPreview && typeof body.includeMessagePreview !== "boolean") {
    return NextResponse.json(
      { error: "includeMessagePreview must be true or false" },
      { status: 400 },
    );
  }
  try {
    const config = await updateSlackSettings(id, {
      ...(hasEvents ? { events: sanitizeSlackEvents(body.events) } : {}),
      ...(hasPreview ? { includeMessagePreview: body.includeMessagePreview as boolean } : {}),
    });
    invalidateSlackHookCache(id);
    return NextResponse.json({ ok: true, config });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isDocId(id)) return notFound();
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;
  try {
    await disconnectSlack(id);
    invalidateSlackHookCache(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
