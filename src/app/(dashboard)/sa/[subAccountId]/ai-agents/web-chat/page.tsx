import { WebChatChannelSection } from "@/components/ai-agents/web-chat-channel-section";
import { WebVoiceSection } from "@/components/ai-agents/web-voice-section";

/**
 * Web Chat channel page — operational settings (enabled, welcome
 * message, theme, allowed domains, overrides) plus the embed snippet,
 * then the optional Web Voice (ElevenLabs) card.
 * The shared persona + KB live on the Overview page.
 */
export default function AiAgentsWebChatPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <WebChatChannelSection />
      <WebVoiceSection />
    </div>
  );
}
