"use client";

import type { RefObject } from "react";
import { Braces } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MERGE_FIELDS } from "@/lib/messaging/merge-tags";

/**
 * "Merge fields" picker (GHL "Custom Values", SP2 T4). Hands the chosen tag
 * to `onPick`; the caller decides whether to insert it raw (snippet editor)
 * or rendered (composer).
 */
export function MergeFieldMenu({
  onPick,
  disabled,
  returnFocusTo,
}: {
  onPick: (tag: string) => void;
  disabled?: boolean;
  /** Where focus goes when the menu closes (the field it inserted into). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="Insert a merge field"
          >
            <Braces className="mr-1 h-3.5 w-3.5" />
            Merge fields
          </Button>
        }
      />
      <DropdownMenuContent
        align="start"
        className="w-56"
        finalFocus={returnFocusTo}
      >
        {MERGE_FIELDS.map((f) => (
          <DropdownMenuItem key={f.tag} onClick={() => onPick(f.tag)}>
            <span className="flex-1">{f.label}</span>
            <code className="text-muted-foreground text-[10px]">{f.tag}</code>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
