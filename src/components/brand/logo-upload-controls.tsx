"use client";

import { useRef, useState } from "react";
import { Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { renderLogo } from "@/lib/brand/render-logo-client";
import { isUploadedLogoUrl, type LogoScope } from "@/lib/brand/logo-shared";

/**
 * Upload / Remove buttons for a logo. Uploading saves immediately (no form
 * Save needed) and reports the new public URL back so the caller's URL field
 * and preview update.
 */
export function LogoUploadControls({
  endpoint,
  scope,
  ownerId,
  currentUrl,
  onChange,
}: {
  /** POST uploads, DELETE removes. */
  endpoint: string;
  /** Whose logo this is; Remove shows only for this owner's own upload. */
  scope: LogoScope;
  ownerId: string | null;
  currentUrl: string;
  onChange: (logoUrl: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);

  async function handleFile(file: File) {
    setBusy("upload");
    try {
      const { base64, mime } = await renderLogo(file);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: base64, mime }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        logoUrl?: string;
        error?: string;
      };
      if (!res.ok || !payload.logoUrl) {
        throw new Error(payload.error ?? "Couldn't upload the logo.");
      }
      onChange(payload.logoUrl);
      toast.success("Logo uploaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload the logo.");
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove() {
    setBusy("remove");
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Couldn't remove the logo.");
      onChange("");
      toast.success("Logo removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the logo.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy !== null}
        onClick={() => inputRef.current?.click()}
      >
        {busy === "upload" ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="mr-1 h-3.5 w-3.5" />
        )}
        {busy === "upload" ? "Uploading…" : "Upload logo"}
      </Button>
      {ownerId && isUploadedLogoUrl(currentUrl, scope, ownerId) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => void handleRemove()}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          {busy === "remove" ? "Removing…" : "Remove"}
        </Button>
      )}
    </div>
  );
}
