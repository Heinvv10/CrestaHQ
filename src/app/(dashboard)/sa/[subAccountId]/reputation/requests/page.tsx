import { ReputationRequests } from "@/components/reputation/requests";

export default function ReputationRequestsPage() {
  // Outside the component, so every state (loading, error, empty) sits inside it.
  return (
    <div className="mx-auto w-full max-w-5xl">
      <ReputationRequests />
    </div>
  );
}
