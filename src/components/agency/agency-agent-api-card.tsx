"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { useAgency } from "@/hooks/use-agency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgencyKeyReachEntry, ApiKeyResponse } from "@/types/api";

/**
 * Agency Agent API: the agency kill switch (`agentApiEnabled`, PATCH
 * /api/agency) and the agency keys (`/api/agency/api-keys`). Rendered inside
 * the Agency Assistant card. An agency key reaches every sub-account with
 * both Public API access and Agent API on, so the mint form lists those
 * sub-accounts by name before the owner confirms, and the reveal repeats
 * the list the mint returned.
 */
export function AgencyAgentApiCard() {
  const agency = useAgency();
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? agency.agentApiEnabled;

  const [keys, setKeys] = useState<ApiKeyResponse[]>([]);
  const [reach, setReach] = useState<AgencyKeyReachEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [minting, setMinting] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState<{
    key: ApiKeyResponse;
    reach: AgencyKeyReachEntry[];
  } | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agency/api-keys");
      const data = (await res.json().catch(() => ({}))) as {
        keys?: ApiKeyResponse[];
        reach?: AgencyKeyReachEntry[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to load keys.");
      setKeys(data.keys ?? []);
      setReach(data.reach ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Loaded with the switch off too: an owner reacting to a leak switches it
  // off first, and must still be able to see and revoke every key.
  useEffect(() => {
    if (!agency.loading) void refetch();
  }, [enabled, agency.loading, refetch]);

  async function handleToggle(next: boolean) {
    setPending(next);
    setSaving(true);
    try {
      const res = await fetch("/api/agency", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentApiEnabled: next }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Could not save.");
      toast.success(
        next
          ? "Agent API switched on for the agency."
          : "Agent API switched off. Every agency key is refused.",
      );
    } catch (err) {
      setPending(null);
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
      setTimeout(() => setPending(null), 2000);
    }
  }

  async function handleMint(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/agency/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        key?: ApiKeyResponse;
        reach?: AgencyKeyReachEntry[];
        error?: string;
      };
      if (!res.ok || !data.key) throw new Error(data.error ?? "Failed to mint key.");
      setRevealed({ key: data.key, reach: data.reach ?? [] });
      setName("");
      setMinting(false);
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mint key.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(key: ApiKeyResponse) {
    if (!confirm(`Revoke "${key.name}"? Any agent using it is refused immediately. This cannot be undone.`)) {
      return;
    }
    setRevokingId(key.id);
    try {
      const res = await fetch(`/api/agency/api-keys/${key.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to revoke key.");
      toast.success("Key revoked.");
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke key.");
    } finally {
      setRevokingId(null);
    }
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Copied to clipboard.");
    } catch {
      toast.error("Clipboard blocked — select the key and copy manually.");
    }
  }

  return (
    <div className="space-y-3 rounded-xl border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Agent API (agency keys)</p>
          <p className="text-[11px] text-muted-foreground">
            Off by default. One agency key lets an external agent work across
            your sub-accounts. While off, every agency key is refused and none
            can be minted; existing keys can still be revoked. Agency keys are
            not accepted by the Agent API yet; this release only mints and
            revokes them.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Agent API for the agency"
          disabled={saving || agency.loading}
          onClick={() => handleToggle(!enabled)}
          className={
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 " +
            (enabled ? "bg-emerald-500" : "bg-muted-foreground/30")
          }
        >
          <span
            className={
              "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform " +
              (enabled ? "translate-x-4" : "translate-x-0.5")
            }
          />
        </button>
      </div>

      {enabled && revealed?.key.secret && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-xs font-medium">
            Copy “{revealed.key.name}” now. You won&apos;t see it again.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-[11px]">
              {revealed.key.secret}
            </code>
            <Button type="button" size="sm" variant="outline" onClick={() => copySecret(revealed.key.secret!)}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ReachList reach={revealed.reach} lead="Minted with reach to" />
          <Button type="button" size="sm" variant="ghost" onClick={() => setRevealed(null)}>
            I&apos;ve saved it
          </Button>
        </div>
      )}

      {enabled && minting && (
        <form onSubmit={handleMint} className="space-y-3 rounded-lg border p-3">
          <div className="space-y-1.5">
            <Label htmlFor="agency-key-name">Name</Label>
            <Input
              id="agency-key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Onboarding agent"
              maxLength={60}
              autoFocus
            />
          </div>
          <ReachList reach={reach} lead="This key will reach" />
          <p className="text-[11px] text-muted-foreground">
            A sub-account that later gets both Public API access and Agent API
            switched on is reached too. Live mode, agent scope only.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMinting(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting || !name.trim()}>
              {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Mint key reaching {reach.length} sub-account{reach.length === 1 ? "" : "s"}
            </Button>
          </div>
        </form>
      )}

      {enabled && !minting && (
        <div className="flex justify-end">
          <Button type="button" size="sm" variant="outline" onClick={() => setMinting(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            New agency key
          </Button>
        </div>
      )}

      {loading ? (
        <p className="flex items-center text-[11px] text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading keys…
        </p>
      ) : keys.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No agency keys yet.</p>
      ) : (
        <ul className="space-y-2">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{k.name}</p>
                <p className="font-mono text-[11px] text-muted-foreground">lsk_live_{k.prefix}_••••••••</p>
                <p className="text-[11px] text-muted-foreground">
                  Created {new Date(k.createdAt).toLocaleDateString()} ·{" "}
                  {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${k.name}`}
                onClick={() => handleRevoke(k)}
                disabled={revokingId === k.id}
                className="shrink-0 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400"
              >
                {revokingId === k.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReachList({ reach, lead }: { reach: AgencyKeyReachEntry[]; lead: string }) {
  if (reach.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {lead} no sub-account yet: none has both Public API access and Agent
        API switched on.
      </p>
    );
  }
  return (
    <div className="text-[11px]">
      <p className="font-medium">
        {lead} {reach.length} sub-account{reach.length === 1 ? "" : "s"}:
      </p>
      <ul className="mt-1 list-inside list-disc text-muted-foreground">
        {reach.map((s) => (
          <li key={s.id}>{s.name}</li>
        ))}
      </ul>
    </div>
  );
}
