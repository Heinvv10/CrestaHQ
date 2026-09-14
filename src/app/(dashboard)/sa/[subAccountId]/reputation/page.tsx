import { ReputationOverview } from "@/components/reputation/overview";

export default function ReputationOverviewPage() {
  // Outside the component, so every state (loading, error, gate-off, empty) sits inside it.
  return (
    <div className="mx-auto w-full max-w-5xl">
      <ReputationOverview />
    </div>
  );
}
