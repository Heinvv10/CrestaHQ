"use client";

import type { ReactNode } from "react";
import { Bot, Pause } from "lucide-react";
import { toDate } from "@/lib/format";
import {
  resumeBot,
  setConversationBotMode,
} from "@/lib/firestore/conversations";
import { cn } from "@/lib/utils";
import type {
  ConversationBotMode,
  ConversationDoc,
} from "@/types/conversations";

const MODES: { value: ConversationBotMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Bot replies automatically" },
  { value: "suggest", label: "Suggest", hint: "Bot drafts; you approve" },
  { value: "off", label: "Off", hint: "Bot stays silent here" },
];

/**
 * Per-conversation AI controls shown under the inbox detail header: the mode
 * toggle (Auto / Suggest / Off) plus a "bot paused" indicator + Resume when a
 * human took over recently. `trailing` sits at the right end of the bar (the
 * thread's Owner picker — the header has no room left for it).
 */
export function ConversationAiControls({
  conversation,
  trailing,
}: {
  conversation: ConversationDoc;
  trailing?: ReactNode;
}) {
  const mode = conversation.botMode ?? "auto";
  const pausedUntil = toDate(conversation.botPausedUntil);
  const paused =
    mode !== "off" && !!pausedUntil && pausedUntil.getTime() > Date.now();

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2">
      <div className="flex items-center gap-2">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground">
          AI replies
        </span>
        <div className="flex gap-0.5 rounded-md border bg-background p-0.5">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              title={m.hint}
              onClick={() =>
                setConversationBotMode(conversation.id, m.value)
              }
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                mode === m.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {paused && (
          <button
            type="button"
            onClick={() => resumeBot(conversation.id)}
            className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
          >
            <Pause className="h-3 w-3" />
            Bot paused — Resume
          </button>
        )}
        {trailing}
      </div>
    </div>
  );
}
