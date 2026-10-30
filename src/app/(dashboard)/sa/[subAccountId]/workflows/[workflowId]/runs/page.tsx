import { Suspense } from "react";
import { WorkflowRuns } from "@/components/workflows/workflow-runs";

export default async function WorkflowRunsPage({
  params,
}: {
  params: Promise<{ subAccountId: string; workflowId: string }>;
}) {
  const { subAccountId, workflowId } = await params;
  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* WorkflowRuns reads `?run=` via useSearchParams, which needs a
          Suspense boundary above it. */}
      <Suspense fallback={null}>
        <WorkflowRuns saId={subAccountId} workflowId={workflowId} />
      </Suspense>
    </div>
  );
}
