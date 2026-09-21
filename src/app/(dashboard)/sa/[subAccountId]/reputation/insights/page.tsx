import { ReputationInsights } from "@/components/reputation/insights";

export default function ReputationInsightsPage() {
  // Outside the component, so every state (loading, error, gate-off, empty) sits inside it.
  return (
    <div className="mx-auto w-full max-w-5xl">
      <ReputationInsights />
    </div>
  );
}
