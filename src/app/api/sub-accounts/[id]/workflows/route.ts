import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  createWorkflowServerSide,
  listWorkflows,
  type WorkflowTemplate,
} from "@/lib/server/workflows-service";

const TEMPLATE_NAMES: Record<Exclude<WorkflowTemplate, "blank">, string> = {
  "speed-to-lead": "Speed-to-Lead",
  "appointment-confirmation": "Appointment Confirmation",
  "lead-nurture": "Lead Nurture",
  "stage-change-followup": "Stage-Change Follow-up",
  "no-reply-followup": "No-reply Follow-up",
};

export const dynamic = "force-dynamic";

/** GET — list this sub-account's workflows. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const workflows = await listWorkflows(subAccountId);
  return NextResponse.json({ workflows });
}

/** POST — create a draft workflow, returns its id. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: subAccountId } = await params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { name?: string; template?: WorkflowTemplate };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const templateName =
    body.template && body.template !== "blank"
      ? TEMPLATE_NAMES[body.template]
      : "Untitled workflow";

  const workflowId = await createWorkflowServerSide({
    subAccountId,
    createdByUid: access.uid,
    name: body.name ?? templateName,
    template: body.template,
  });
  return NextResponse.json({ id: workflowId });
}
