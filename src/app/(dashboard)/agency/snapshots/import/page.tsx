"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, Layers, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useAgency } from "@/hooks/use-agency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Accept either a bare token or the whole share URL pasted into the box. */
function tokenFrom(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).searchParams.get("token") ?? "";
  } catch {
    return trimmed;
  }
}

/**
 * Landing page for a snapshot share link. Importing copies the shared
 * snapshot into the signed-in owner's agency; nothing is applied to a
 * sub-account until they pick it on the new sub-account form.
 */
function ImportSnapshot() {
  const params = useSearchParams();
  const { loading, agencyRole } = useAuth();
  const agency = useAgency();
  const [pasted, setPasted] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const urlToken = params.get("token") ?? "";
  const token = urlToken || tokenFrom(pasted);

  async function handleImport() {
    if (!token || importing) return;
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/agency/snapshots/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Import failed.");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <div className="h-40 animate-pulse rounded-2xl bg-muted/40" />
      </div>
    );
  }

  if (agencyRole !== "owner") {
    return (
      <div className="mx-auto w-full max-w-3xl rounded-2xl border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Only an agency owner can import a snapshot. Ask the owner of your
          agency to open this link.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <section className="rounded-2xl border bg-card p-6">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Layers className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">
              Import snapshot into {agency.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              Another agency shared a snapshot with you. Importing adds a copy
              to your snapshot library — forms, workflows, templates, products,
              custom fields and AI persona. It carries no customer data or
              credentials, and changes none of your sub-accounts.
            </p>
          </div>
        </div>

        {done ? (
          <div className="space-y-3">
            <p className="text-sm">
              Imported. You&apos;ll find it on the Imported tab of the Snapshots
              panel, and in the snapshot picker when you create a sub-account.
            </p>
            <Button render={<Link href="/agency/sub-accounts" />}>
              Go to sub-accounts
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {!urlToken && (
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Share link
                <Input
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder="Paste the snapshot share link"
                  className="h-9"
                />
              </label>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              data-testid="snapshot-import-button"
              onClick={handleImport}
              disabled={!token || importing}
            >
              {importing ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-1 h-3.5 w-3.5" />
              )}
              Import
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

export default function ImportSnapshotPage() {
  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-3xl" />}>
      <ImportSnapshot />
    </Suspense>
  );
}
