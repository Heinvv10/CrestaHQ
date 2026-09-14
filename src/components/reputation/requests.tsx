"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSubAccount } from "@/context/sub-account-context";
import { CHANNEL_LABEL, SOURCE_LABEL } from "./format";
import { SendReviewRequestButton } from "./send-review-request";

/**
 * Reputation → Requests (SP5 d1): every logged review ask, newest first, 50 at
 * a time. Status / channel / source filters run on the server; the name
 * search runs over the rows already loaded, and says so.
 */

export interface RequestRow {
  id: string;
  contactId: string | null;
  contactName: string | null;
  channel: string;
  source: string;
  trigger: string | null;
  status: "sent" | "failed";
  failureKind: string | null;
  sentAt: string | null;
}

type Filters = { status: string; channel: string; source: string };
type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; rows: RequestRow[]; nextCursor: string | null; more: "idle" | "loading" | "error" };

const TRIGGER_LABEL: Record<string, string> = { manual: "manual", quote_paid: "quote paid", deal_completed: "deal completed" };
const OPTIONS = {
  status: [["", "Any status"], ["sent", "Sent"], ["failed", "Failed"]],
  channel: [["", "Any channel"], ["sms", "SMS"], ["whatsapp", "WhatsApp"], ["email", "Email"]],
  source: [["", "Any sender"], ...Object.entries(SOURCE_LABEL)],
} as const;

const fmtSentAt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function sentBy(r: RequestRow): string {
  const label = SOURCE_LABEL[r.source] ?? r.source;
  return r.source === "dispatcher" && r.trigger ? `${label} · ${TRIGGER_LABEL[r.trigger] ?? r.trigger}` : label;
}

export function ReputationRequests() {
  const { subAccountId } = useSubAccount();
  const [filters, setFilters] = useState<Filters>({ status: "", channel: "", source: "" });
  const [search, setSearch] = useState("");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reload, setReload] = useState(0);
  // Bumped by every fresh load, so a Load more started before a filter change is dropped.
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (cursor: string | null, signal?: AbortSignal) => {
      const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
      if (cursor) q.set("cursor", cursor);
      const res = await fetch(`/api/sub-accounts/${subAccountId}/reputation/requests?${q}`, { signal });
      const data = (await res.json()) as { requests?: RequestRow[]; nextCursor?: string | null };
      if (!res.ok || !Array.isArray(data.requests)) throw new Error("requests_load_failed");
      return { rows: data.requests, nextCursor: data.nextCursor ?? null };
    },
    [subAccountId, filters],
  );

  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setLoad({ state: "loading" });
    fetchPage(null, controller.signal).then(
      (p) => setLoad({ state: "ready", ...p, more: "idle" }),
      () => !controller.signal.aborted && setLoad({ state: "error" }),
    );
    return () => controller.abort();
  }, [fetchPage, reload]);

  async function loadMore() {
    if (load.state !== "ready" || !load.nextCursor) return;
    const gen = generation.current;
    setLoad({ ...load, more: "loading" });
    try {
      const p = await fetchPage(load.nextCursor);
      if (gen === generation.current) setLoad({ state: "ready", rows: [...load.rows, ...p.rows], nextCursor: p.nextCursor, more: "idle" });
    } catch {
      if (gen === generation.current) setLoad({ ...load, more: "error" });
    }
  }

  const term = search.trim().toLowerCase();
  const shown = useMemo(
    () => (load.state !== "ready" ? [] : term ? load.rows.filter((r) => (r.contactName ?? "").toLowerCase().includes(term)) : load.rows),
    [load, term],
  );
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-4" data-testid="rep-requests-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Review requests</h1>
        <SendReviewRequestButton onSent={() => setReload((n) => n + 1)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(OPTIONS) as Array<keyof Filters>).map((f) => (
          <select
            key={f}
            value={filters[f]}
            onChange={(e) => setFilters({ ...filters, [f]: e.target.value })}
            className="rounded-md border bg-background px-2 py-1 text-sm"
            data-testid={`rep-req-filter-${f}`}
            aria-label={`Filter by ${f === "source" ? "sender" : f}`}
          >
            {OPTIONS[f].map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        ))}
        <label className="relative ml-auto min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contact name"
            aria-label="Search contact name"
            className="h-8 w-full rounded-md border bg-background pl-8 pr-2 text-sm"
            data-testid="rep-req-search"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="rep-req-search-note">
        The search looks through the requests loaded below only — use Load more to search further back.
      </p>
      {filters.status === "failed" && (
        <p className="text-xs text-muted-foreground" data-testid="rep-req-failed-note">
          Failed lists sends a provider rejected from workflows, broadcasts and the inbox. A Request review that could not
          be sent is not logged — the Send Review Request dialog shows why instead.
        </p>
      )}

      {load.state === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="rep-req-loading">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {load.state === "error" && (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="rep-req-error">
          The requests could not be loaded. Please try again.
        </p>
      )}
      {load.state === "ready" && load.rows.length === 0 && (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="rep-req-empty">
          {filtered
            ? load.nextCursor
              ? "No requests match these filters among the most recent ones. Load more to look further back."
              : "No requests match these filters."
            : "No review requests have been logged yet."}
        </p>
      )}
      {load.state === "ready" && load.rows.length > 0 && shown.length === 0 && (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="rep-req-no-match">
          No loaded request is for a contact named like “{search.trim()}”.
        </p>
      )}
      {shown.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Contact</th>
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Sent by</th>
                <th className="px-3 py-2 font-medium">Sent at</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t" data-testid="rep-req-row" data-source={r.source} data-status={r.status}>
                  <td className="px-3 py-2">
                    {r.contactId === null ? (
                      <span className="text-muted-foreground">Outside your territories</span>
                    ) : r.contactName !== null ? (
                      <Link href={`/sa/${subAccountId}/contacts/${r.contactId}`} className="font-medium underline-offset-2 hover:underline">
                        {r.contactName || "(unnamed contact)"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Deleted contact</span>
                    )}
                  </td>
                  <td className="px-3 py-2">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="px-3 py-2">{sentBy(r)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{fmtSentAt(r.sentAt)}</td>
                  <td className="px-3 py-2">
                    {r.status === "failed" ? (
                      <span className="text-destructive" title={r.failureKind ?? undefined}>Failed</span>
                    ) : (
                      "Sent"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {load.state === "ready" && load.nextCursor && (
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={load.more === "loading"} data-testid="rep-req-more">
            {load.more === "loading" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Load more
          </Button>
          {load.more === "error" && (
            <span className="text-xs text-destructive" data-testid="rep-req-more-error">Couldn&apos;t load more. Try again.</span>
          )}
        </div>
      )}
    </div>
  );
}
