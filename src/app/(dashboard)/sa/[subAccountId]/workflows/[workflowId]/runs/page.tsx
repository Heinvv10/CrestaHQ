import { WorkflowRuns } from "@/components/workflows/workflow-runs";

export default async function WorkflowRunsPage({
  params,
}: {
  params: Promise<{ subAccountId: string; workflowId: string }>;
}) {
  const { subAccountId, workflowId } = await params;
  return (
    <div className="mx-auto w-full max-w-5xl">
      <WorkflowRuns saId={subAccountId} workflowId={workflowId} />
    </div>
  );
}
