import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { isDocId } from "@/lib/server/doc-id";
import {
  WebVoiceError,
  connectWebVoice,
  disconnectWebVoice,
  listWebVoiceVoices,
  updateWebVoiceSettings,
} from "@/lib/server/web-voice-service";
import type { SubAccountDoc } from "@/types";
import type { WebVoiceSettings } from "@/types/web-voice";

export const dynamic = "force-dynamic";

/**
 * Web Voice connection (ElevenLabs Web Voice v1) — sub-account admins.
 *
 * GET    — status: gate, display meta, and (with `?voices=1`) the live voice
 *          list from the client's account. Today's/month's minutes and the
 *          settings page's preview widget token arrive with the call path
 *          (WV-2), which owns the usage doc and the token.
 * POST   — `{ apiKey }` connect or replace the key (probed before storing).
 * PATCH  — `{ enabled?, voiceId?, voiceName?, language?, greeting?,
 *          maxCallSeconds?, dailyMinuteCap? }` save settings + re-sync agent.
 * DELETE — disconnect (deletes the ElevenLabs agent best-effort). Ungated so
 *          a client can always remove their key.
 *
 * POST and PATCH answer 403 `gate_off` while `webVoiceEnabledByAgency` is
 * off. The key is never returned — only `keyLast4` on the display meta.
 */

async function loadSub(subAccountId: string): Promise<SubAccountDoc | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.exists ? (snap.data() as SubAccountDoc) : null;
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
}

function gateOff(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Web Voice isn't enabled for this workspace. Ask your agency owner to turn it on.",
      code: "gate_off",
    },
    { status: 403 },
  );
}

function errorResponse(err: unknown, fallback: string): NextResponse {
  if (err instanceof WebVoiceError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(`[web-voice] ${fallback}`, err instanceof Error ? err.message : String(err));
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  if (!isDocId(subAccountId)) return notFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = await loadSub(subAccountId);
  if (!sub) return notFound();

  const gateOn = sub.webVoiceEnabledByAgency === true;
  const meta = sub.webVoiceMeta ?? null;
  const wantVoices = new URL(request.url).searchParams.get("voices") === "1";

  let voices: Awaited<ReturnType<typeof listWebVoiceVoices>> = [];
  let voicesError: string | null = null;
  if (gateOn && meta && wantVoices) {
    try {
      voices = await listWebVoiceVoices(subAccountId);
    } catch (err) {
      voicesError = err instanceof WebVoiceError ? err.message : "Couldn't load voices.";
    }
  }

  return NextResponse.json({
    gateOn,
    webChatGateOn: sub.webChatEnabledByAgency !== false,
    meta,
    voices,
    voicesError,
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  if (!isDocId(subAccountId)) return notFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = await loadSub(subAccountId);
  if (!sub) return notFound();
  if (sub.webVoiceEnabledByAgency !== true) return gateOff();

  let body: { apiKey?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body?.apiKey !== "string" || !body.apiKey.trim()) {
    return NextResponse.json({ error: "Paste your ElevenLabs API key." }, { status: 400 });
  }

  try {
    const { meta, voices } = await connectWebVoice({ subAccountId, apiKey: body.apiKey });
    return NextResponse.json({ ok: true, meta, voices });
  } catch (err) {
    return errorResponse(err, "Couldn't connect ElevenLabs.");
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  if (!isDocId(subAccountId)) return notFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = await loadSub(subAccountId);
  if (!sub) return notFound();
  if (sub.webVoiceEnabledByAgency !== true) return gateOff();

  let body: Partial<WebVoiceSettings>;
  try {
    body = (await request.json()) as Partial<WebVoiceSettings>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: Partial<WebVoiceSettings> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.voiceId === "string") patch.voiceId = body.voiceId;
  if (typeof body.voiceName === "string") patch.voiceName = body.voiceName;
  if (typeof body.language === "string") patch.language = body.language;
  if (typeof body.greeting === "string") patch.greeting = body.greeting;
  if (body.maxCallSeconds !== undefined) patch.maxCallSeconds = Number(body.maxCallSeconds);
  if (body.dailyMinuteCap !== undefined) patch.dailyMinuteCap = Number(body.dailyMinuteCap);

  try {
    const meta = await updateWebVoiceSettings({ subAccountId, patch });
    return NextResponse.json({ ok: true, meta });
  } catch (err) {
    return errorResponse(err, "Couldn't save voice settings.");
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  if (!isDocId(subAccountId)) return notFound();
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    await disconnectWebVoice(subAccountId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "Couldn't disconnect ElevenLabs.");
  }
}
