"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * ApexGEO connection — the sub-account's own ApexGEO API key, used by
 * prospect reports for website performance, AI readiness and AI search
 * presence (sections 5/7/8). Every member sees whether it is connected;
 * owners/admins paste, test, save and remove the key.
 *
 * The key is never rendered back: the server keeps it in a locked
 * subcollection and this card reads only `apexgeoConnected`,
 * `apexgeoKeyLast4` and `apexgeoBaseUrl` off the sub-account doc.
 */
export function SubAccountApexgeoSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const connected = subAccount?.apexgeoConnected === true;

  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "remove" | null>(null);
  const [tested, setTested] = useState<{ ok: boolean; reason: string | null } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const url = `/api/sub-accounts/${subAccountId}/apexgeo-connection`;
  const pasted = () => ({ apiKey: key.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) });

  async function send(method: string, path: string, body?: unknown) {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; reason?: string | null };
    return { res, data };
  }

  async function test(body?: unknown) {
    setBusy("test");
    setTested(null);
    try {
      const { res, data } = await send("POST", `${url}/test`, body);
      setTested(
        res.ok ? { ok: data.ok === true, reason: data.reason ?? null } : { ok: false, reason: data.error ?? "Couldn't test the key." },
      );
    } catch {
      setTested({ ok: false, reason: "Couldn't test the key." });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    try {
      const { res, data } = await send("PUT", url, pasted());
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Couldn't connect ApexGEO.");
      setKey("");
      setBaseUrl("");
      setTested(null);
      toast.success("ApexGEO connected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't connect ApexGEO.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      const { res, data } = await send("DELETE", url);
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Couldn't remove the key.");
      setTested(null);
      toast.success("ApexGEO key removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the key.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6" data-testid="apexgeo-section">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">ApexGEO</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Adds website speed, AI readiness and AI search presence to prospect reports. Each report
            runs one scan on your own ApexGEO account and uses its credits.
          </p>
        </div>
      </header>

      {connected ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            Connected
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            API key ending {subAccount?.apexgeoKeyLast4 ?? "••••"}
            {subAccount?.apexgeoBaseUrl ? ` · ${subAccount.apexgeoBaseUrl}` : ""}
          </p>
          {tested ? <TestResult {...tested} /> : null}
          {isAdmin ? (
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => test()} disabled={busy !== null}>
                {busy === "test" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Test
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmRemove(true)}
                disabled={busy !== null}
              >
                {busy === "remove" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Remove
              </Button>
            </div>
          ) : null}
        </div>
      ) : !isAdmin ? (
        <p className="text-sm text-muted-foreground">
          Not connected. Ask a sub-account admin to add an ApexGEO key.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="apexgeo-key">API key</Label>
            <Input
              id="apexgeo-key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setTested(null);
              }}
              placeholder="apx_…"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              In ApexGEO, create an API key with <span className="font-medium">read</span> and{" "}
              <span className="font-medium">write</span> scopes. Stored securely and never shown again —
              only the last 4 characters are displayed. Test checks the key without spending credits.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apexgeo-base-url">Base URL (optional)</Label>
            <Input
              id="apexgeo-base-url"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setTested(null);
              }}
              placeholder="https://apexgeo.app"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {tested ? <TestResult {...tested} /> : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => test(pasted())}
              disabled={busy !== null || !key.trim()}
            >
              {busy === "test" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Test
            </Button>
            <Button type="button" size="sm" onClick={save} disabled={busy !== null || !key.trim()}>
              {busy === "save" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the ApexGEO key?</AlertDialogTitle>
            <AlertDialogDescription>
              New prospect reports will skip website speed, AI readiness and AI search presence until a
              key is added again. Scans already running stop at their next check.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmRemove(false);
                void remove();
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function TestResult({ ok, reason }: { ok: boolean; reason: string | null }) {
  return ok ? (
    <p role="status" className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
      Key works — ApexGEO accepted it.
    </p>
  ) : (
    <p role="alert" className="mt-2 text-xs text-destructive">
      {reason ?? "The key did not work."}
    </p>
  );
}
