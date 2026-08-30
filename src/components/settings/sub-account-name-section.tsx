"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Tag } from "lucide-react";
import { toast } from "sonner";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SubAccountNameSection() {
  const { subAccount, subAccountId, isAdmin } = useSubAccount();

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(subAccount?.name ?? "");
  }, [subAccount]);

  if (!isAdmin) return null;

  const currentName = subAccount?.name ?? "";
  const trimmed = name.trim();
  const dirty = trimmed !== currentName;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) {
      toast.error("Workspace name can't be empty.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save.");
      toast.success("Workspace name saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          <Tag className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Workspace name</h2>
          <p className="text-xs text-muted-foreground">
            The name of this sub-account. Shown in the sidebar switcher, page
            headers, and the agency workspace list.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="workspace-name">Name</Label>
          <Input
            id="workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Plumbing"
            maxLength={80}
          />
          <p className="text-[11px] text-muted-foreground">
            Renaming only changes the display name — links, data, and members are
            unaffected.
          </p>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving || !dirty || !trimmed}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </section>
  );
}
