"use client";

import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown, Clock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  announceScheduledChange,
  scheduledMessagesBase,
} from "@/hooks/use-scheduled-messages";
import { scheduleTimeZone } from "@/lib/conversations/schedule-time";
import { SendLaterPanel } from "./send-later-panel";

/** What the composer would send right now, minus the time. */
export interface SendLaterRequest {
  contactId: string;
  channel: "email" | "sms" | "whatsapp" | "messenger" | "instagram";
  body: string;
  subject?: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * The composer's Send button with GHL's "Send · Send later" menu (SP2 T5).
 * `children` is the composer's own submit button, untouched; this adds the
 * chevron beside it and the date/time panel above it. Times are picked in the
 * sub-account's timezone (the browser's when it has none), named on screen.
 *
 * The composer supplies `buildRequest` — the exact payload its Send would
 * post — so a scheduled message is the message the operator is looking at.
 */
export function SendLaterMenu({
  children,
  disabled,
  buildRequest,
  onScheduled,
}: {
  children: ReactNode;
  disabled: boolean;
  /** Null when there is nothing sendable (empty body, missing subject, raw tag). */
  buildRequest: () => SendLaterRequest | null;
  onScheduled: () => void;
}) {
  const { subAccountId, subAccount } = useSubAccount();
  const zone = scheduleTimeZone(subAccount?.timezone);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  async function schedule(sendAt: string): Promise<boolean> {
    const request = buildRequest();
    if (!request) return false;
    try {
      const res = await fetch(scheduledMessagesBase(subAccountId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, sendAt }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `Couldn't schedule (HTTP ${res.status}).`);
      }
      toast.success("Message scheduled.");
      onScheduled();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't schedule.");
      return false;
    } finally {
      // Refresh the thread either way: a booking the scheduler refused is
      // recorded as failed and should be visible, not silently dropped.
      announceScheduledChange(request.contactId);
    }
  }

  return (
    <div ref={wrapperRef} className="relative flex items-center">
      {children}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              aria-label="More send options"
              className="-ml-px rounded-l-none border-l border-l-primary-foreground/30 px-1.5"
            />
          }
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            // The menu renders in a portal, outside the form — reach the
            // composer's form through the wrapper instead.
            onClick={() => wrapperRef.current?.closest("form")?.requestSubmit()}
          >
            Send now
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setOpen(true)}>
            <Clock className="mr-1 h-3.5 w-3.5" />
            Send later…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && (
        <SendLaterPanel
          zone={zone}
          disabled={disabled}
          onSchedule={schedule}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
