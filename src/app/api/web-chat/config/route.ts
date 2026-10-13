import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { checkOriginAllowed } from "@/lib/comms/web-chat/origin";
import { isHexColor } from "@/lib/checkout/themes";
import {
  readWebVoiceConnection,
  webVoiceAvailable,
} from "@/lib/server/web-voice-service";
import { runAfterResponse } from "@/lib/server/after-response";
import { sweepStalePending, webVoiceCapReached } from "@/lib/server/web-voice-usage";
import { claimConfigSweep } from "@/lib/web-voice/rate-limit";
import { issueWidgetToken } from "@/lib/web-voice/tokens";
import { DEFAULT_WEB_CHAT_CONFIG } from "@/types/ai";
import type { SubAccountDoc } from "@/types";
import { isDocId } from "@/lib/server/doc-id";

export const dynamic = "force-dynamic";

/**
 * Public endpoint hit by the widget loader on every page-load to fetch
 * theme + welcome message + enabled state. Validates the Origin header
 * against the channel's allowedDomains list — when the origin isn't
 * allowed we still return 200 with `{ enabled: false }` so the loader
 * silently disables itself instead of throwing a CORS error in the
 * page's console (which would alarm the buyer's client).
 *
 * Always returns CORS headers since the widget calls this from the host
 * page's origin.
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
  const url = new URL(request.url);
  const subAccountId = url.searchParams.get("sa");
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);

  if (!subAccountId || !isDocId(subAccountId)) {
    return NextResponse.json(
      { error: "Missing sa param" },
      { status: 400, headers },
    );
  }

  const config = await getChannelConfig(subAccountId, "web-chat");
  if (!config || !config.enabled || !config.webChat) {
    return NextResponse.json(
      { enabled: false },
      { status: 200, headers },
    );
  }

  // Agency gate: if the agency hasn't enabled Web Chat for this sub-account,
  // report disabled so the widget loader silently no-ops (same shape as an
  // origin miss). Only read the sub doc once the channel itself is enabled.
  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sa = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sa || !aiChannelGateOn(sa, "web-chat")) {
    return NextResponse.json({ enabled: false }, { status: 200, headers });
  }

  const originCheck = checkOriginAllowed(origin, config.webChat.allowedDomains);
  if (!originCheck.allowed) {
    return NextResponse.json(
      { enabled: false, reason: originCheck.reason },
      { status: 200, headers },
    );
  }

  // Web Voice (ElevenLabs Web Voice v1): this is the origin-checked request,
  // so it's where the widget gets the token /voice/start requires. Hidden
  // once today's minute cap is reached. Any failure just hides the mic.
  let voice: { voiceEnabled: boolean; voiceToken?: string } = { voiceEnabled: false };
  if (webVoiceAvailable(sa)) {
    try {
      const conn = await readWebVoiceConnection(subAccountId);
      const capReached = !!conn?.agentId && (await webVoiceCapReached(subAccountId, conn));
      if (conn?.agentId && !capReached) {
        const voiceToken = issueWidgetToken(subAccountId);
        if (voiceToken) voice = { voiceEnabled: true, voiceToken };
      } else if (conn && capReached && claimConfigSweep(subAccountId)) {
        // A cap filled by provisional charges (abandoned starts) recovers
        // without waiting for a visitor to reach /voice/start, which the
        // hidden mic would never let happen.
        runAfterResponse(() =>
          sweepStalePending({ subAccountId, conn }).catch((err: unknown) => {
            console.warn(
              `[web-chat/config] voice usage sweep failed sa=${subAccountId}`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        );
      }
    } catch (err) {
      console.warn(
        `[web-chat/config] voice check failed sa=${subAccountId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Backward-safe: if any of the web-chat fields are missing on the doc
  // (older docs created before defaults shipped), fall back to defaults.
  return NextResponse.json(
    {
      enabled: true,
      ...voice,
      welcomeMessage:
        config.webChat.welcomeMessage || DEFAULT_WEB_CHAT_CONFIG.welcomeMessage,
      // widget.js writes this into a style on the embedding site: a plain hex only.
      accentColor: isHexColor(config.webChat.accentColor)
        ? config.webChat.accentColor
        : DEFAULT_WEB_CHAT_CONFIG.accentColor,
      position: config.webChat.position || DEFAULT_WEB_CHAT_CONFIG.position,
    },
    { status: 200, headers },
  );
}
