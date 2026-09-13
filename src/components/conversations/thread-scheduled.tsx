"use client";

import { AlertCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatInZone } from "@/lib/conversations/schedule-time";
import { scheduledItemState } from "@/lib/conversations/scheduled-item";
import { cn } from "@/lib/utils";
import type { ScheduledMessageView } from "@/types/scheduled-messages";

const LABEL: Record<ScheduledMessageView["channel"], string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
};

/**
 * A scheduled message inline in the thread (SP2 T5). Deliberately NOT a sent
 * bubble: dashed outline and a clock, so nobody reads a message that has not
 * gone yet as one the customer has. A pending one can be cancelled; a failed
 * or unconfirmed one says why and can be dismissed.
 */
export function ThreadScheduled({
  message,
  timeZone,
  onRemove,
}: {
  message: ScheduledMessageView;
  timeZone: string;
  onRemove: (id: string) => void;
}) {
  const state = scheduledItemState(message, formatInZone(message.sendAt, timeZone), Date.now());
  const alarm = state.tone === "failed" || state.tone === "overdue";
  const warn = state.tone === "unconfirmed";
  return (
    <div
      data-testid="thread-scheduled"
      data-status={message.status}
      data-tone={state.tone}
      className="flex flex-col items-end"
    >
      <div
        className={cn(
          "max-w-[78%] rounded-2xl rounded-br-sm border border-dashed px-3 py-2 text-sm",
          alarm
            ? "border-destructive/60 bg-destructive/5"
            : warn
              ? "border-amber-500/60 bg-amber-500/10"
              : "border-primary/50 bg-primary/5"
        )}
      >
        {message.subject && <p className="mb-1 font-semibold">{message.subject}</p>}
        <p className="break-words whitespace-pre-wrap">{message.body}</p>
        {(state.tone === "failed" || state.tone === "unconfirmed") && message.failureReason && (
          <p
            className={cn(
              "mt-2 flex items-start gap-1 text-xs",
              warn ? "text-amber-700 dark:text-amber-400" : "text-destructive"
            )}
          >
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{message.failureReason}</span>
          </p>
        )}
      </div>
      <div className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[10px]">
        <Clock className="h-3 w-3" />
        <span>
          {LABEL[message.channel]} · {state.label}
        </span>
        {state.action && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px]"
            onClick={() => onRemove(message.id)}
          >
            {state.action === "cancel" ? "Cancel" : "Dismiss"}
          </Button>
        )}
      </div>
    </div>
  );
}
