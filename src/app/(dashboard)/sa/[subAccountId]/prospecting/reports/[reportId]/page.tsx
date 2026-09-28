"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { ReportSections } from "@/components/prospecting/report-view";
import type { PublicReportSection } from "@/lib/prospecting/public-sections";
import type { ProspectReportStatus } from "@/types/prospecting";

/**
 * One prospect report, for members of the sub-account (opened from the
 * contact's Prospect reports card). Renders the same section rows as the
 * public share page, from GET /api/sub-accounts/[id]/prospecting/reports/[reportId],
 * with a toggle that lists the raw metrics and the rows the public page hides.
 */

interface MemberReport {
  id: string;
  contactId: string;
  status: ProspectReportStatus;
  headline: string | null;
  /** Already whitelisted server-side (no `raw`). */
  sections: PublicReportSection[];
  generatedAt: string | null;
}

type State =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; report: MemberReport };

export default function ProspectReportPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const { subAccountId, saPath } = useSubAccount();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!subAccountId || !reportId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/sub-accounts/${subAccountId}/prospecting/reports/${encodeURIComponent(reportId)}`);
        const data = (await res.json().catch(() => ({}))) as {
          report?: MemberReport;
          code?: string;
          error?: string;
        };
        if (cancelled) return;
        if (res.status === 404) setState({ kind: "not_found" });
        else if (res.status === 403 && data.code === "gate_off") {
          setState({ kind: "error", message: "Prospecting is locked by your agency." });
        } else if (!res.ok || !data.report) {
          setState({ kind: "error", message: data.error ?? "Couldn't load the report." });
        } else setState({ kind: "ready", report: data.report });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "Couldn't load the report." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subAccountId, reportId]);

  if (state.kind !== "ready") {
    return (
      <div className="mx-auto w-full max-w-5xl">
        {state.kind === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
          </div>
        ) : (
          <div className="rounded-xl border border-dashed bg-card/50 p-12 text-center">
            <h2 className="text-lg font-semibold">
              {state.kind === "not_found" ? "Report not found" : "Couldn't load the report"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {state.kind === "not_found"
                ? "It may have been deleted, or it belongs to another sub-account."
                : state.message}
            </p>
            <Link href={saPath("/contacts")} className="mt-4 inline-block text-sm underline">
              Back to contacts
            </Link>
          </div>
        )}
      </div>
    );
  }

  const { report } = state;
  const generated = report.generatedAt
    ? new Date(report.generatedAt).toLocaleDateString("en-ZA", { dateStyle: "long" })
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <Link
        href={saPath(`/contacts/${report.contactId}`)}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to contact
      </Link>
      <div>
        <p className="text-sm text-muted-foreground">
          Online presence report{generated ? ` · ${generated}` : ""}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {report.headline ?? (report.status === "ready" ? "No issues found" : `Report ${report.status}`)}
        </h1>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          aria-pressed={showAll}
          onClick={() => setShowAll((v) => !v)}
          className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {showAll ? "Hide raw metrics and hidden rows" : "Show raw metrics and hidden rows"}
        </button>
      </div>
      <ReportSections sections={report.sections} connectHref={saPath("/dashboard/settings")} showAll={showAll} />
    </div>
  );
}
