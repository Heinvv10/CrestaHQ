import { WorkflowsList } from "@/components/workflows/workflows-list";

export default async function WorkflowsPage({
  params,
}: {
  params: Promise<{ subAccountId: string }>;
}) {
  const { subAccountId } = await params;
  return (
    <div className="mx-auto max-w-5xl">
      <WorkflowsList saId={subAccountId} />
    </div>
  );
}
