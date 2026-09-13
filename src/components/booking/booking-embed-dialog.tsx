"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Code2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * "Embed" action on a published booking page: two ready-to-paste snippets
 * for a buyer's website — the auto-resizing script+div (preferred) and a
 * plain fixed-height iframe fallback for sites that can't run the loader
 * script. Both point at the same /embed/booking/[saId]/[slug] surface as
 * the loader mounts.
 */

const appUrl = () =>
  (process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(
    /\/+$/,
    "",
  );

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function scriptSnippet(subAccountId: string, slug: string): string {
  const app = escapeAttr(appUrl());
  const ref = escapeAttr(`${subAccountId}/${slug}`);
  return [
    `<div data-leadstack-booking="${ref}"></div>`,
    `<script src="${app}/booking-embed.js" async></script>`,
  ].join("\n");
}

function iframeSnippet(subAccountId: string, slug: string): string {
  const app = escapeAttr(appUrl());
  return `<iframe src="${app}/embed/booking/${escapeAttr(subAccountId)}/${escapeAttr(slug)}" style="width:100%;height:720px;border:0;" title="Book a meeting"></iframe>`;
}

function copy(snippet: string) {
  void navigator.clipboard
    .writeText(snippet)
    .then(() => toast.success("Snippet copied."))
    .catch(() => toast.error("Copy failed — select the snippet and copy it by hand."));
}

export function BookingEmbedDialog({
  subAccountId,
  slug,
}: {
  subAccountId: string;
  slug: string;
}) {
  const [open, setOpen] = useState(false);
  const script = scriptSnippet(subAccountId, slug);
  const iframe = iframeSnippet(subAccountId, slug);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            <Code2 className="mr-1 h-3.5 w-3.5" />
            Embed
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Embed this booking page</DialogTitle>
          <DialogDescription>
            Paste either snippet into your website&apos;s HTML.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-sm font-medium">
            Recommended — auto-sizing widget
          </p>
          <p className="text-xs text-muted-foreground">
            Resizes itself to fit the picker and form as the visitor
            progresses. Works on any page.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
            {script}
          </pre>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => copy(script)}
          >
            Copy snippet
          </Button>
        </div>

        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-medium">Plain iframe</p>
          <p className="text-xs text-muted-foreground">
            For sites that can&apos;t run the loader script. Fixed height —
            you may need to adjust it.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
            {iframe}
          </pre>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => copy(iframe)}
          >
            Copy snippet
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
