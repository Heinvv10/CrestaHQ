"use client";

import { useRef, useState } from "react";
import { Loader2, Smartphone, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { renderIconVariants } from "@/lib/pwa/render-icons-client";
import { Button } from "@/components/ui/button";

/**
 * Agency settings — "Mobile app icon" card. The Branding section's logo
 * URL brands the pages (sidebar, landing); THIS is what phones show on
 * the home screen after installing the app. The browser renders the four
 * required variants on a canvas (contain-fit onto a filled square, extra
 * safe-zone padding for Android's maskable crop) and posts them; the
 * server validates + stores, and the manifest picks them up immediately.
 * Already-installed devices keep their cached icon until reinstall — a
 * platform behavior worth stating in the helper copy.
 */

const ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";

export function AppIconSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  // Bumped after every change so the <img> previews refetch.
  const [previewNonce, setPreviewNonce] = useState(() => Date.now());

  async function handleFile(file: File) {
    setBusy("upload");
    try {
      const icons = await renderIconVariants(file);
      const res = await fetch("/api/agency/app-icon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icons }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Upload failed.");
      setPreviewNonce(Date.now());
      toast.success(
        "App icon updated — new installs use it right away. Already-installed devices keep the old icon until they reinstall.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleRemove() {
    setBusy("remove");
    try {
      const res = await fetch("/api/agency/app-icon", { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn't remove the icon.");
      setPreviewNonce(Date.now());
      toast.success("App icon reset to the default mark.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          <Smartphone className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Mobile app icon</h2>
          <p className="text-xs text-muted-foreground">
            The home-screen icon shown when someone installs your app on
            their phone. Separate from the logo above — icons need a square
            mark, not a wide wordmark.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {/* Live previews straight from the serving route — falls back to
            the default mark until an upload exists. */}
        <div className="flex items-end gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/pwa/icon/192?p=${previewNonce}`}
            alt="App icon preview"
            width={56}
            height={56}
            className="rounded-xl border"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/pwa/icon/maskable?p=${previewNonce}`}
            alt="Maskable icon preview (Android crops to a circle)"
            width={56}
            height={56}
            className="rounded-full border"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            Upload a square image, ideally 512×512 or larger (PNG, JPG, WebP,
            or SVG). We generate every size phones need, including the padded
            variant Android crops into a circle — shown right.
          </p>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={handleRemove}
        >
          {busy === "remove" ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="mr-1 h-3.5 w-3.5" />
          )}
          Reset to default
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
        >
          {busy === "upload" ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="mr-1 h-3.5 w-3.5" />
          )}
          Upload icon
        </Button>
      </div>
    </section>
  );
}
