"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** `/pay/link/{token}` on whatever origin the operator is using. */
export function payLinkUrl(token: string): string {
  return `${window.location.origin}/pay/link/${token}`;
}

export function CopyablePayUrl({ token }: { token: string }) {
  const url = payLinkUrl(token);
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(url);
          toast.success("Payment link copied");
        }}
      >
        <Copy className="h-4 w-4" />
        Copy
      </Button>
    </div>
  );
}
