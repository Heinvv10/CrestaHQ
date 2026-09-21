import { GoogleBusinessPanel } from "@/components/gbp/google-business-panel";
import { WidgetSection } from "@/components/gbp/widget-section";

export default function AiAgentsGoogleBusinessPage() {
  // The wrapper is outside the panel, so EVERY panel state (loading, locked,
  // not-admin, disconnected, reconnect, picker, selected) sits inside it.
  return (
    <div className="mx-auto w-full max-w-5xl">
      <GoogleBusinessPanel />
      {/* The public reviews widget: admins only; with the gate off, only Revoke. */}
      <WidgetSection />
    </div>
  );
}
