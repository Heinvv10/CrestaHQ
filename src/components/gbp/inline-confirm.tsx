"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A destructive action behind an inline "are you sure?" — never confirm():
 * native dialogs freeze browser automation (and the E2E suite with it).
 */
export function InlineConfirm({
  label,
  confirmLabel,
  prompt,
  onConfirm,
  testId,
}: {
  label: string;
  confirmLabel: string;
  prompt: string;
  onConfirm: () => Promise<void>;
  testId?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!asking) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setAsking(true)} data-testid={testId}>
        {label}
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{prompt}</span>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
        {confirmLabel}
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </div>
  );
}
