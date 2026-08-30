"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Pencil,
  Activity,
  GitBranch,
  CalendarCheck,
  CheckSquare,
  FileText,
  FileSignature,
  Mail,
  MessageSquare,
  MessagesSquare,
  PhoneMissed,
  PhoneOutgoing,
  Zap,
  Send,
  CircleSlash,
  CheckCircle2,
  XCircle,
  Eye,
  DollarSign,
  AlertTriangle,
  MapPinned,
  CalendarPlus,
  CalendarX,
  CalendarClock,
  UserX,
  Users,
  Star,
  MonitorPlay,
  MousePointerClick,
} from "lucide-react";
import { subscribeToNotes } from "@/lib/firestore/contacts";
import { subscribeToActivities } from "@/lib/firestore/activities";
import { formatRelativeTime } from "@/lib/format";
import { useSubAccount } from "@/context/sub-account-context";
import type { Note, ActivityType } from "@/types/contacts";
import type { ActivityDoc } from "@/types/activities";

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

  useEffect(() => {
    setLoadedNotes(false);
    setLoadedActs(false);
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
    <ol className="before:bg-border relative space-y-4 pl-6 before:absolute before:top-2 before:bottom-2 before:left-3 before:w-px">
      {items.map((item) =>
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
  );
}

function ActivityRow({
  item,
}: {
  item: Extract<TimelineItem, { kind: "activity" }>;
}) {
  const { saPath } = useSubAccount();
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
  return (
    <TimelineRow
      icon={visuals.icon}
      label={visuals.label}
      when={item.createdAt}
    >
      <p className="text-sm leading-relaxed">{item.content}</p>
      {links.length > 0 && (
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

function activityVisuals(type: ActivityType): {
  icon: React.ReactNode;
  label: string;
} {
  switch (type) {
    case "pipeline_moved":
      return {
        icon: <GitBranch className="h-3 w-3 text-indigo-500" />,
        label: "Pipeline updated",
      };
    case "booking_created":
      return {
        icon: <CalendarCheck className="h-3 w-3 text-emerald-500" />,
        label: "Event scheduled",
      };
    case "task_completed":
      return {
        icon: <CheckSquare className="h-3 w-3 text-emerald-500" />,
        label: "Task completed",
      };
    case "form_submitted":
      return {
        icon: <FileText className="h-3 w-3 text-violet-500" />,
        label: "Form submitted",
      };
    case "email_sent":
      return {
        icon: <Mail className="h-3 w-3 text-blue-500" />,
        label: "Email sent",
      };
    case "sms_sent":
      return {
        icon: <MessageSquare className="h-3 w-3 text-violet-500" />,
        label: "SMS sent",
      };
    case "whatsapp_sent":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-green-500" />,
        label: "WhatsApp sent",
      };
    case "messenger_sent":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-blue-500" />,
        label: "Messenger sent",
      };
    case "instagram_sent":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-pink-500" />,
        label: "Instagram sent",
      };
    case "voice_call_initiated":
      return {
        icon: <PhoneOutgoing className="h-3 w-3 text-orange-500" />,
        label: "AI call placed",
      };
    case "voice_call_completed":
      return {
        icon: <PhoneOutgoing className="h-3 w-3 text-emerald-500" />,
        label: "AI call",
      };
    case "missed_call":
      return {
        icon: <PhoneMissed className="h-3 w-3 text-rose-500" />,
        label: "Missed call",
      };
    case "automation_started":
      return {
        icon: <Zap className="h-3 w-3 text-amber-500" />,
        label: "Automation started",
      };
    case "automation_step_sent":
      return {
        icon: <Send className="h-3 w-3 text-violet-500" />,
        label: "Automation step sent",
      };
    case "automation_step_skipped":
      return {
        icon: <CircleSlash className="text-muted-foreground h-3 w-3" />,
        label: "Automation step skipped",
      };
    case "automation_completed":
      return {
        icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
        label: "Automation completed",
      };
    case "automation_failed":
      return {
        icon: <AlertTriangle className="h-3 w-3 text-rose-500" />,
        label: "Automation failed",
      };
    case "quote_sent":
      return {
        icon: <FileSignature className="h-3 w-3 text-blue-500" />,
        label: "Quote sent",
      };
    case "quote_viewed":
      return {
        icon: <Eye className="h-3 w-3 text-indigo-500" />,
        label: "Quote viewed",
      };
    case "quote_accepted":
      return {
        icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
        label: "Quote accepted",
      };
    case "quote_declined":
      return {
        icon: <XCircle className="h-3 w-3 text-rose-500" />,
        label: "Quote declined",
      };
    case "quote_marked_paid":
      return {
        icon: <DollarSign className="h-3 w-3 text-emerald-500" />,
        label: "Quote paid",
      };
    case "review_requested":
      return {
        icon: <Star className="h-3 w-3 text-amber-500" />,
        label: "Review requested",
      };
    case "contact_territory_changed":
      return {
        icon: <MapPinned className="h-3 w-3 text-sky-500" />,
        label: "Territory changed",
      };
    case "booking_page_booked":
      return {
        icon: <CalendarPlus className="h-3 w-3 text-teal-500" />,
        label: "Meeting booked",
      };
    case "booking_payment_received":
      return {
        icon: <DollarSign className="h-3 w-3 text-emerald-500" />,
        label: "Booking payment received",
      };
    case "booking_cancelled":
      return {
        icon: <CalendarX className="h-3 w-3 text-rose-500" />,
        label: "Meeting cancelled",
      };
    case "booking_rescheduled":
      return {
        icon: <CalendarClock className="h-3 w-3 text-amber-500" />,
        label: "Meeting rescheduled",
      };
    case "booking_no_show":
      return {
        icon: <UserX className="h-3 w-3 text-rose-500" />,
        label: "No-show",
      };
    case "booking_completed":
      return {
        icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
        label: "Meeting completed",
      };
    case "booking_reassigned":
      return {
        icon: <Users className="h-3 w-3 text-indigo-500" />,
        label: "Booking reassigned",
      };
    case "webinar_registered":
      return {
        icon: <MonitorPlay className="h-3 w-3 text-violet-500" />,
        label: "Webinar registration",
      };
    case "webinar_joined":
      return {
        icon: <MonitorPlay className="h-3 w-3 text-sky-500" />,
        label: "Joined webinar",
      };
    case "webinar_completed":
      return {
        icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
        label: "Webinar completed",
      };
    case "webinar_cta_clicked":
      return {
        icon: <MousePointerClick className="h-3 w-3 text-amber-500" />,
        label: "Webinar offer clicked",
      };
    case "note_added":
    default:
      return {
        icon: <Pencil className="text-muted-foreground h-3 w-3" />,
        label: "Note added",
      };
  }
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
