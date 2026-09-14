import { ReputationSettings } from "@/components/reputation/settings";

export default function ReputationSettingsPage() {
  // A settings surface: max-w-3xl on every state (docs/architecture/key-architecture.md).
  return (
    <div className="mx-auto w-full max-w-3xl">
      <ReputationSettings />
    </div>
  );
}
