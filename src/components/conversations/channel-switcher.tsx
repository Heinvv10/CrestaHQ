"use client";

import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChannelOption } from "@/lib/conversations/channel-availability";
import {
  waWindowLabel,
  type WaWindowState,
} from "@/lib/comms/whatsapp/window-state";
import type { ConversationChannel } from "@/types/conversations";

/**
 * SP2 T7 — every composer channel, always listed. An unavailable one is a
 * disabled pill carrying its reason, so an operator on a WhatsApp thread
 * sees WHY WhatsApp cannot be used instead of finding it missing.
 */
export function ChannelSwitcher({
  options,
  value,
  onChange,
}: {
  options: ChannelOption[];
  value: ConversationChannel;
  onChange: (channel: ConversationChannel) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Reply channel"
      className="mb-2 flex flex-wrap gap-1"
    >
      {options.map((o) => (
        <button
          key={o.channel}
          type="button"
          data-testid={`channel-option-${o.channel}`}
          disabled={!o.available}
          aria-pressed={o.available ? value === o.channel : undefined}
          title={o.reason ?? undefined}
          onClick={() => onChange(o.channel)}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
            !o.available
              ? "text-muted-foreground/70 cursor-not-allowed border-dashed"
              : value === o.channel
                ? "border-primary bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted"
          )}
        >
          {o.label}
          {o.reason && <span className="font-normal"> · {o.reason}</span>}
        </button>
      ))}
    </div>
  );
}

/** SP2 T8 — "Window open · closes in 3h 12m" / "Window closed — …". */
export function WhatsappWindowBadge({ state }: { state: WaWindowState }) {
  const label = waWindowLabel(state);
  if (!label) return null;
  return (
    <p
      data-testid="wa-window-state"
      className={cn(
        "mb-2 flex items-center gap-1.5 text-[11px] font-medium",
        state.kind === "open"
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-amber-700 dark:text-amber-400"
      )}
    >
      <Clock className="h-3.5 w-3.5" />
      {label}
    </p>
  );
}
