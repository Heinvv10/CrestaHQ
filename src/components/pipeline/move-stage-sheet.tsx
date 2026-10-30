"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import type { Deal, PipelineStage, PipelineStageId } from "@/types/deals";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * Mobile bottom sheet for moving a deal between stages — the phone-native
 * alternative to cross-column touch-drag (which stays as the desktop
 * pattern). Opened from the deal card's "Move stage" button (itself only
 * rendered below md). Selecting "lost" routes through the same lost-reason
 * dialog the drag path uses — the caller handles that in onMove.
 */
export function MoveStageSheet({
  deal,
  stages,
  onClose,
  onMove,
}: {
  deal: Deal | null;
  stages: PipelineStage[];
  onClose: () => void;
  onMove: (stageId: PipelineStageId) => void;
}) {
  return (
    <Sheet open={!!deal} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle className="truncate text-left text-sm">
            {deal
              ? `Move "${deal.title}" · ${formatCurrency(deal.value, deal.currency)}`
              : "Move deal"}
          </SheetTitle>
        </SheetHeader>
        <div className="space-y-1 px-4 pb-4">
          {stages.map((stage) => {
            const current = deal?.stageId === stage.id;
            return (
              <button
                key={stage.id}
                type="button"
                disabled={current}
                onClick={() => onMove(stage.id)}
                className={cn(
                  "flex min-h-11 w-full items-center justify-between rounded-lg border px-3 text-sm transition-colors active:bg-muted",
                  current
                    ? "cursor-default border-primary/40 bg-primary/5"
                    : "hover:bg-muted/50",
                )}
              >
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                    stage.tone,
                  )}
                >
                  {stage.label}
                </span>
                {current && <Check className="h-4 w-4 text-primary" />}
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
