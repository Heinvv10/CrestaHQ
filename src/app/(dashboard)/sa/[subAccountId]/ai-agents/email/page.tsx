import { EmailChannelSection } from "@/components/ai-agents/email-channel-section";

/**
 * Email AI channel page — DRAFT-ONLY replies to inbound emails the connected
 * mailbox imports. The shared persona lives on the Overview page; the
 * mailbox and email sending are configured under Settings → Messaging.
 */
export default function AiAgentsEmailPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <EmailChannelSection />
    </div>
  );
}
