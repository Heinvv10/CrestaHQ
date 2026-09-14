import { ReputationSettings } from "@/components/reputation/tab-panels";

export default function ReputationSettingsPage() {
  // A settings surface: max-w-3xl on every state (loading, not-admin, the form).
  return (
    <div className="mx-auto w-full max-w-3xl">
      <ReputationSettings />
    </div>
  );
}
