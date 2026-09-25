"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  refusalText,
  STATUS_LABELS,
  type ApprovalRow,
} from "@/lib/approvals/messages";

type Decision = "approve" | "reject" | "mark_sent" | "mark_not_sent";

/**
 * One agent proposal. `preview` rows are rendered VERBATIM — the approver
 * judges exactly what the server says will happen; `pinned` never reaches
 * the browser. Every decision sends the row's `rev`; a changed preview
 * replaces the row in place and says so.
 */
export function ApprovalCard({
  subAccountId,
  row,
  onReplace,
  onChanged,
}: {
  subAccountId: string;
  row: ApprovalRow;
  /** The server returned a fresher version of this row (preview_changed). */
  onReplace: (row: ApprovalRow) => void;
  /** The row moved on; reload the list. */
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<Decision | null>(null);
  const [confirmPriorOpen, setConfirmPriorOpen] = useState(false);

  async function decide(decision: Decision, extra: Record<string, unknown> = {}) {
    setBusy(decision);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/agent-proposals/${row.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, rev: row.rev, ...extra }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
        rev?: string;
        preview?: ApprovalRow["preview"];
        resultText?: string;
      };
      if (res.status === 409 && data.error === "preview_changed" && data.rev && data.preview) {
        onReplace({ ...row, rev: data.rev, preview: data.preview });
        toast.warning("What this will do changed since you loaded it. Review it again before approving.");
        return;
      }
      if (res.status === 409 && data.error === "previous_attempt_sent" && decision === "approve") {
        setConfirmPriorOpen(true);
        return;
      }
      if (res.status === 202) toast.warning("It's taking a while, so the outcome isn't known yet. Check back soon.");
      else if (res.ok) toast.success(data.resultText ?? "Done.");
      else if (res.status === 422) toast.error(data.error ?? "The action failed.");
      else toast.error(refusalText(data.error, row, data.error));
      await onChanged();
    } catch {
      toast.error("Couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const approve = () =>
    row.priorAttemptSent ? setConfirmPriorOpen(true) : void decide("approve");
  const liveDeal = row.live?.deal;
  const dealMoved =
    liveDeal && (!liveDeal.exists || liveDeal.stageId !== row.args?.context?.toStage);

  return (
    <div className="bg-card space-y-3 rounded-2xl border p-4" data-testid={`approval-${row.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium">{row.summary}</p>
        <Badge variant={row.status === "unsettled" ? "destructive" : "secondary"}>
          {STATUS_LABELS[row.status] ?? row.status}
        </Badge>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="approval-preview">
        {row.preview.map((r, i) => (
          <div key={i} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="break-words whitespace-pre-wrap">{r.value}</dd>
          </div>
        ))}
      </dl>

      {liveDeal && (
        <p
          className={dealMoved ? "text-sm text-amber-600 dark:text-amber-400" : "text-muted-foreground text-sm"}
          data-testid="approval-live-deal"
        >
          {liveDeal.exists
            ? `The deal is now in ${liveDeal.stageLabel ?? liveDeal.stageId}.`
            : "The deal no longer exists."}
          {dealMoved && " Approving will be refused unless it is back where this says."}
        </p>
      )}

      {row.priorAttemptSent && row.status === "pending" && (
        <p className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400" data-testid="approval-prior-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          An earlier attempt of this exact action already went out. Approving sends it again.
        </p>
      )}

      {(row.status === "failed" || row.status === "rejected") && (row.error || row.reason) && (
        <p className="text-destructive text-sm" data-testid="approval-error">
          {row.error ?? row.reason}
        </p>
      )}
      {row.status === "executed" && row.result?.resultText && (
        <p className="text-muted-foreground text-sm">{row.result.resultText}</p>
      )}

      {row.status === "pending" && (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy !== null} onClick={approve}>
            {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve
          </Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide("reject")}>
            {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            Reject
          </Button>
        </div>
      )}

      {row.status === "unsettled" && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            We don&apos;t know whether this went out. Check before deciding
            {row.contactId ? (
              <>
                {" — "}
                <Link className="text-primary underline" href={`/sa/${subAccountId}/conversations/${row.contactId}`}>
                  open the conversation
                </Link>
              </>
            ) : null}
            .
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide("mark_sent")}>
              It went out
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide("mark_not_sent")}>
              It did not go out
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmPriorOpen} onOpenChange={setConfirmPriorOpen}>
        <AlertDialogContent data-testid="approval-prior-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Send this again?</AlertDialogTitle>
            <AlertDialogDescription>
              An earlier attempt of this exact action already went out. Approving
              does it a second time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="approval-prior-confirm"
              onClick={() => {
                setConfirmPriorOpen(false);
                void decide("approve", { acknowledgePriorAttempt: true });
              }}
            >
              Yes, send it again
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
