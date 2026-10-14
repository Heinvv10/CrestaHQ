"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, Pencil } from "lucide-react";
import { subscribeToNotes } from "@/lib/firestore/contacts";
import { subscribeToActivities } from "@/lib/firestore/activities";
import { formatRelativeTime } from "@/lib/format";
import { useSubAccount } from "@/context/sub-account-context";
import type { Note, ActivityType } from "@/types/contacts";
import type { ActivityDoc } from "@/types/activities";
import { activityVisuals } from "@/components/contacts/activity-visuals";
import { ownRecordingUrl } from "@/lib/comms/dialer-shared";
import {
  ACTIVITY_FILTERS,
  matchesActivityFilter,
  type ActivityFilter,
} from "@/lib/contacts/activity-filter";

type TimelineItem =
  | { kind: "note"; id: string; createdAt: Note["createdAt"]; content: string }
  | {
      kind: "activity";
      id: string;
      type: ActivityType;
      createdAt: ActivityDoc["createdAt"];
      content: string;
      meta: ActivityDoc["meta"];
    };

export function ActivityTimeline({ contactId }: { contactId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activities, setActivities] = useState<ActivityDoc[]>([]);
  const [loadedNotes, setLoadedNotes] = useState(false);
  const [loadedActs, setLoadedActs] = useState(false);
  const [filter, setFilter] = useState<ActivityFilter>("all");

  useEffect(() => {
    setLoadedNotes(false);
    setLoadedActs(false);
    setFilter("all");
    const unsubNotes = subscribeToNotes(contactId, (list) => {
      setNotes(list);
      setLoadedNotes(true);
    });
    const unsubActs = subscribeToActivities(contactId, (list) => {
      setActivities(list);
      setLoadedActs(true);
    });
    return () => {
      unsubNotes();
      unsubActs();
    };
  }, [contactId]);

  const loading = !loadedNotes || !loadedActs;

  const items: TimelineItem[] = useMemo(() => {
    const merged: TimelineItem[] = [
      ...notes.map((n) => ({
        kind: "note" as const,
        id: n.id,
        createdAt: n.createdAt,
        content: n.content,
      })),
      ...activities.map((a) => ({
        kind: "activity" as const,
        id: a.id,
        type: a.type,
        createdAt: a.createdAt,
        content: a.content,
        meta: a.meta,
      })),
    ];
    merged.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
    return merged;
  }, [notes, activities]);

  const visible = useMemo(
    () =>
      items.filter((item) =>
        matchesActivityFilter(
          item.kind === "note" ? "note_added" : item.type,
          filter
        )
      ),
    [items, filter]
  );

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card rounded-xl border p-4">
            <div className="bg-muted mb-2 h-3 w-24 animate-pulse rounded" />
            <div className="bg-muted h-4 w-full animate-pulse rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="bg-card/50 rounded-xl border border-dashed p-8 text-center">
        <Activity className="text-muted-foreground mx-auto h-6 w-6" />
        <p className="mt-2 text-sm font-medium">No activity yet</p>
        <p className="text-muted-foreground text-xs">
          Notes and updates will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        role="group"
        aria-label="Filter activity"
        className="flex flex-wrap gap-1.5"
      >
        {ACTIVITY_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            aria-pressed={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={
              filter === f.value
                ? "border-primary bg-primary/10 text-primary rounded-full border px-2.5 py-1 text-xs"
                : "text-muted-foreground hover:bg-muted rounded-full border px-2.5 py-1 text-xs"
            }
          >
            {f.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing in this category yet.
        </p>
      ) : (
        <ol className="before:bg-border relative space-y-4 pl-6 before:absolute before:top-2 before:bottom-2 before:left-3 before:w-px">
          {visible.map((item) =>
            item.kind === "note" ? (
              <TimelineRow
                key={`n-${item.id}`}
                icon={<Pencil className="text-muted-foreground h-3 w-3" />}
                label="Note added"
                when={item.createdAt}
              >
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {item.content}
                </p>
              </TimelineRow>
            ) : (
              <ActivityRow key={`a-${item.id}`} item={item} />
            )
          )}
        </ol>
      )}
    </div>
  );
}

function ActivityRow({
  item,
}: {
  item: Extract<TimelineItem, { kind: "activity" }>;
}) {
  const { saPath, subAccount } = useSubAccount();
  const visuals = activityVisuals(item.type);
  // The meta ids below were always being stored by the writers (quote
  // lifecycle, booking lifecycle, broadcasts, capture tasks) — render
  // them as deep-links instead of leaving them write-only payload.
  const meta = item.meta;
  const links: { href: string; label: string }[] = [];
  if (meta?.dealId) {
    links.push({ href: saPath("/pipeline"), label: "View in pipeline →" });
  }
  if (meta?.quoteId) {
    links.push({
      href: saPath(`/quotes/${meta.quoteId}`),
      label: meta.quoteNumber ? `View ${meta.quoteNumber} →` : "View quote →",
    });
  }
  if (meta?.eventId || meta?.bookingId) {
    links.push({ href: saPath("/calendar"), label: "View on calendar →" });
  }
  if (meta?.broadcastId) {
    links.push({
      href: saPath(`/broadcasts/${meta.broadcastId}`),
      label: "View broadcast →",
    });
  }
  if (meta?.taskId) {
    links.push({ href: saPath("/tasks"), label: "View task →" });
  }
  // Engine-written rows link to that run in the workflow's run history,
  // which opens and highlights it.
  if (meta?.workflowId && meta?.runId) {
    links.push({
      href: saPath(`/workflows/${meta.workflowId}/runs?run=${meta.runId}`),
      label: "View run →",
    });
  }
  // A dialer call's recording. `meta` is UNTRUSTED — members can write
  // activity rows directly — so it becomes a link only when it is exactly a
  // recording on this sub-account's own Twilio account (the rule the status
  // webhook stores it under). A plain link in a new tab: never embedded,
  // never auto-played.
  const recordingUrl =
    item.type === "call_placed"
      ? ownRecordingUrl(meta?.recordingUrl, subAccount?.twilioConfig?.accountSid)
      : null;
  return (
    <TimelineRow
      icon={visuals.icon}
      label={visuals.label}
      when={item.createdAt}
    >
      <p className="text-sm leading-relaxed">{item.content}</p>
      {(links.length > 0 || recordingUrl) && (
        <span className="mt-1 flex flex-wrap gap-x-3">
          {links.map((l) => (
            <Link
              key={l.href + l.label}
              href={l.href}
              className="text-primary inline-block text-xs hover:underline"
            >
              {l.label}
            </Link>
          ))}
          {recordingUrl && (
            <a
              href={recordingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary inline-block text-xs hover:underline"
            >
              Open recording →
            </a>
          )}
        </span>
      )}
    </TimelineRow>
  );
}

function TimelineRow({
  icon,
  label,
  when,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  when: Note["createdAt"];
  children: React.ReactNode;
}) {
  return (
    <li className="relative">
      <span className="bg-background absolute top-3 -left-[14px] flex h-6 w-6 items-center justify-center rounded-full border">
        {icon}
      </span>
      <div className="bg-card rounded-xl border p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {label}
          </span>
          <span className="text-muted-foreground text-xs">
            {formatRelativeTime(when)}
          </span>
        </div>
        {children}
      </div>
    </li>
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
