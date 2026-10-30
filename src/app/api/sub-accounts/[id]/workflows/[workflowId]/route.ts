import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { recordSubAccountAuditEvent } from "@/lib/audit/record";
import {
  aiSmsActivationBlock,
  deleteWorkflowServerSide,
  getWorkflow,
  updateWorkflowServerSide,
  type WorkflowPatch,
} from "@/lib/server/workflows-service";
import { getAdminDb } from "@/lib/firebase/admin";
import { isFolderId } from "@/lib/workflows/folders";
import { sanitizeNodes } from "@/lib/workflows/sanitize-nodes";
import { templateProblem } from "@/lib/comms/ai/outbound-sms-text";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; workflowId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, workflowId } = await params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const workflow = await getWorkflow(subAccountId, workflowId);
  if (!workflow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ workflow });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; workflowId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, workflowId } = await params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: WorkflowPatch = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (body.status === "draft" || body.status === "active" || body.status === "paused") {
    patch.status = body.status;
  }
  if (body.trigger && typeof body.trigger === "object") {
    patch.trigger = body.trigger as WorkflowPatch["trigger"];
  }
  if (
    body.reentry === "every_time" ||
    body.reentry === "unless_active" ||
    body.reentry === "once_ever"
  ) {
    patch.reentry = body.reentry;
  }
  if (body.startNodeId === null || typeof body.startNodeId === "string") {
    patch.startNodeId = body.startNodeId as string | null;
  }
  if (body.nodes !== undefined) {
    const nodes = sanitizeNodes(body.nodes);
    if (nodes === null) {
      return NextResponse.json({ error: "Invalid nodes" }, { status: 400 });
    }
    patch.nodes = nodes;
    // A Send AI text template that can never work is refused as it is saved;
    // an empty one may sit in a draft (activation and the send refuse it).
    for (const n of Object.values(nodes)) {
      const template = n.type === "send_ai_sms" ? String(n.config.template ?? "") : "";
      const problem = template.trim() ? templateProblem(template) : null;
      if (problem) return NextResponse.json({ error: `Send AI text: ${problem}` }, { status: 400 });
    }
  }
  // Move between folders. The folder is looked up under THIS sub-account's
  // path, so another sub-account's folder id is simply not found — 404, with
  // nothing written and nothing said about whether it exists elsewhere.
  if (body.folderId === null) {
    patch.folderId = null;
  } else if (body.folderId !== undefined) {
    const folder = isFolderId(body.folderId)
      ? await getAdminDb()
          .doc(`subAccounts/${subAccountId}/workflowFolders/${body.folderId}`)
          .get()
      : null;
    if (!folder?.exists) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }
    patch.folderId = folder.id;
  }

  // A workflow that will be active with a Send AI text step needs AI texts
  // enabled and ready here.
  if (patch.status === "active" || patch.nodes !== undefined) {
    const existing = await getWorkflow(subAccountId, workflowId);
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if ((patch.status ?? existing.status) === "active") {
      const block = await aiSmsActivationBlock(subAccountId, patch.nodes ?? existing.nodes);
      if (block) return NextResponse.json({ error: block }, { status: 400 });
    }
  }

  const updated = await updateWorkflowServerSide({ subAccountId, workflowId, patch });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (patch.status !== undefined && patch.status !== updated.previousStatus) {
    await recordSubAccountAuditEvent(getAdminDb(), subAccountId, {
      action: "workflow.status_changed",
      actor: { type: "user", id: access.uid },
      target: { type: "workflow", id: workflowId },
      changes: [{ field: "status", before: updated.previousStatus, after: patch.status }],
    });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; workflowId: string }> },
): Promise<NextResponse> {
  const { id: subAccountId, workflowId } = await params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const ok = await deleteWorkflowServerSide(subAccountId, workflowId);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
