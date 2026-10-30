import { MetaChannelSection } from "@/components/ai-agents/meta-channel-section";

/**
 * Messenger + Instagram DM channel page — operational settings only (enabled,
 * model, context, escalation overrides). The shared persona lives on the
 * Overview page; the Meta connection is managed under Settings → Facebook &
 * Instagram.
 */
export default function AiAgentsMetaPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <MetaChannelSection />
    </div>
  );
}
