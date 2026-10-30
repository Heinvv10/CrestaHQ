import { notFound } from "next/navigation";
import { getChannelConfig } from "@/lib/comms/ai/agent";
import { ChatWindow } from "@/components/web-chat/chat-window";
import { isHexColor } from "@/lib/checkout/themes";
import { DEFAULT_WEB_CHAT_CONFIG } from "@/types/ai";

export const dynamic = "force-dynamic";

/**
 * /embed/chat/[subAccountId] — the iframe target loaded by the widget
 * snippet. Renders the chat UI for that sub-account using its saved
 * theme (accent color + welcome message). No auth.
 *
 * Two failure modes both render 404:
 *   - The sub-account exists but web-chat is disabled
 *   - The web-chat channel doc doesn't exist (never configured)
 *
 * Origin allowlist enforcement happens at the API layer
 * (/api/web-chat/message), not here — the page itself is harmless even
 * if iframed from an off-list domain because it can't send messages.
 */
export default async function EmbedChatPage({
  params,
}: {
  params: Promise<{ subAccountId: string }>;
}) {
  const { subAccountId } = await params;
  const config = await getChannelConfig(subAccountId, "web-chat");
  if (!config || !config.enabled || !config.webChat) {
    notFound();
  }

  const welcomeMessage =
    config.webChat.welcomeMessage || DEFAULT_WEB_CHAT_CONFIG.welcomeMessage;
  // Sent to the client and written into the widget's CSS: a plain hex only.
  const accentColor = isHexColor(config.webChat.accentColor)
    ? config.webChat.accentColor
    : DEFAULT_WEB_CHAT_CONFIG.accentColor;

  return (
    <ChatWindow
      subAccountId={subAccountId}
      welcomeMessage={welcomeMessage}
      accentColor={accentColor}
      embedded
    />
  );
}
