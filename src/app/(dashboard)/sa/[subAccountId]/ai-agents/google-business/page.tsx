import { GoogleBusinessPanel } from "@/components/gbp/google-business-panel";

export default function AiAgentsGoogleBusinessPage() {
  // The wrapper is outside the panel, so EVERY panel state (loading, locked,
  // not-admin, disconnected, reconnect, picker, selected) sits inside it.
  return (
    <div className="mx-auto w-full max-w-5xl">
      <GoogleBusinessPanel />
    </div>
  );
}
