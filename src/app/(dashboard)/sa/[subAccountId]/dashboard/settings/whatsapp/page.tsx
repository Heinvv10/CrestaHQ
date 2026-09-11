import { WhatsappSettings } from "@/components/settings/whatsapp/whatsapp-settings";

export default function WhatsappSettingsPage() {
  // The wrapper is outside the component, so EVERY state (loading, locked,
  // empty, error, ready) sits inside the settings width.
  return (
    <div className="mx-auto max-w-3xl">
      <WhatsappSettings />
    </div>
  );
}
