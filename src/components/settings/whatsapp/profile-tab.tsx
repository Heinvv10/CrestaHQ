"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MediaPickerDialog } from "@/components/media/media-picker-dialog";
import { WA_PROFILE_LIMITS } from "@/lib/comms/whatsapp/settings/types";
import { PhonePreview } from "./phone-preview";
import { VERTICAL_LABELS, errorOf, type WaBusinessProfile, type WaPhoneStatus } from "./types";

/**
 * The Profile tab: read-modify-write against Meta (no cache — the form loads
 * from `GET /profile` and PUTs the full form back). The display name is
 * Meta's to change, so it is read-only with the name-review status beside it.
 */

const EMPTY: WaBusinessProfile = {
  about: "", address: "", description: "", email: "", websites: [], vertical: "UNDEFINED", profilePictureUrl: null,
};

const same = (a: WaBusinessProfile, b: WaBusinessProfile) =>
  JSON.stringify({ ...a, profilePictureUrl: null }) === JSON.stringify({ ...b, profilePictureUrl: null });

function Counter({ value, max }: { value: string; max: number }) {
  return <span className="text-[11px] text-muted-foreground">{value.length}/{max}</span>;
}

export function ProfileTab({
  subAccountId,
  phone,
  isAdmin,
}: {
  subAccountId: string;
  phone: WaPhoneStatus;
  isAdmin: boolean;
}) {
  const base = `/api/sub-accounts/${subAccountId}/whatsapp/profile`;
  const [saved, setSaved] = useState<WaBusinessProfile | null>(null);
  const [form, setForm] = useState<WaBusinessProfile>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setError(null);
    const res = await fetch(base).catch(() => null);
    if (!res?.ok) {
      setError(await errorOf(res, "Couldn't load the profile from Meta."));
      return;
    }
    const data = (await res.json()) as WaBusinessProfile;
    setSaved(data);
    setForm(data);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per sub-account
  }, [subAccountId]);

  const set = (patch: Partial<WaBusinessProfile>) => setForm((f) => ({ ...f, ...patch }));
  const setSite = (i: number, value: string) =>
    setForm((f) => {
      const websites = [f.websites[0] ?? "", f.websites[1] ?? ""];
      websites[i] = value;
      return { ...f, websites };
    });
  const dirty = saved !== null && !same(saved, form);
  const readOnly = !isAdmin;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const { profilePictureUrl: _p, ...input } = form;
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, websites: input.websites.filter((w) => w.trim()) }),
      }).catch(() => null);
      if (!res?.ok) {
        toast.error(await errorOf(res, "Couldn't save the profile."));
        return;
      }
      const data = (await res.json()) as { profile: WaBusinessProfile };
      setSaved(data.profile);
      setForm(data.profile);
      toast.success("Profile saved");
    } finally {
      setSaving(false);
    }
  }

  async function handlePhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    await sendPhoto({ method: "POST", body: fd });
  }

  // Both sources land on the same route and the same byte check server-side.
  async function sendPhoto(init: RequestInit) {
    setUploading(true);
    try {
      const res = await fetch(`${base}/photo`, init).catch(() => null);
      if (!res?.ok) {
        toast.error(await errorOf(res, "Couldn't upload the photo."));
        return;
      }
      const data = (await res.json()) as { profilePictureUrl: string | null };
      setSaved((s) => (s ? { ...s, profilePictureUrl: data.profilePictureUrl } : s));
      set({ profilePictureUrl: data.profilePictureUrl });
      toast.success("Profile photo updated");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (error) {
    return (
      <div className="rounded-2xl border bg-card p-5 text-sm" data-testid="wa-profile-error">
        <p className="text-rose-600 dark:text-rose-400">{error}</p>
        <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!saved) {
    return <div className="h-40 animate-pulse rounded-2xl border bg-muted/30" data-testid="wa-profile-loading" />;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <form onSubmit={handleSave} className="space-y-4 rounded-2xl border bg-card p-5" data-testid="wa-profile-form">
        <div className="flex items-center gap-4">
          {form.profilePictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Meta CDN / data URL
            <img src={form.profilePictureUrl} alt="Profile photo" className="h-16 w-16 rounded-full object-cover" data-testid="wa-profile-photo-img" />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground" data-testid="wa-profile-photo-placeholder">
              {(phone.verifiedName ?? "?").slice(0, 1).toUpperCase()}
            </span>
          )}
          {isAdmin && (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                disabled={uploading}
                onChange={handlePhoto}
                data-testid="wa-profile-photo-input"
              />
              <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()} data-testid="wa-profile-photo-button">
                {uploading ? (<><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Uploading…</>) : "Upload photo"}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="ml-2" disabled={uploading} onClick={() => setPickerOpen(true)} data-testid="wa-profile-photo-library">
                Choose from library
              </Button>
              <p className="mt-1 text-[11px] text-muted-foreground">JPEG or PNG, up to 5 MB.</p>
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="wa-profile-display-name">Display name</Label>
          <Input
            id="wa-profile-display-name"
            value={phone.verifiedName ?? ""}
            readOnly
            aria-readonly="true"
            className="bg-muted/50 text-muted-foreground"
            data-testid="wa-profile-display-name"
          />
          <p className="mt-1 text-xs text-muted-foreground" data-testid="wa-name-status">
            Set by Meta. Name status: {phone.nameStatus ?? "unknown"}
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between"><Label htmlFor="wa-profile-about">About</Label><Counter value={form.about} max={WA_PROFILE_LIMITS.about} /></div>
          <Input id="wa-profile-about" value={form.about} maxLength={WA_PROFILE_LIMITS.about} disabled={readOnly} onChange={(e) => set({ about: e.target.value })} data-testid="wa-profile-about" />
        </div>
        <div>
          <div className="flex items-center justify-between"><Label htmlFor="wa-profile-description">Description</Label><Counter value={form.description} max={WA_PROFILE_LIMITS.description} /></div>
          <Textarea id="wa-profile-description" rows={3} value={form.description} maxLength={WA_PROFILE_LIMITS.description} disabled={readOnly} onChange={(e) => set({ description: e.target.value })} data-testid="wa-profile-description" />
        </div>
        <div>
          <Label htmlFor="wa-profile-category">Category</Label>
          <select
            id="wa-profile-category"
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={form.vertical}
            disabled={readOnly}
            onChange={(e) => set({ vertical: e.target.value })}
            data-testid="wa-profile-category"
          >
            {VERTICAL_LABELS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="flex items-center justify-between"><Label htmlFor="wa-profile-address">Address</Label><Counter value={form.address} max={WA_PROFILE_LIMITS.address} /></div>
          <Input id="wa-profile-address" value={form.address} maxLength={WA_PROFILE_LIMITS.address} disabled={readOnly} onChange={(e) => set({ address: e.target.value })} data-testid="wa-profile-address" />
        </div>
        <div>
          <div className="flex items-center justify-between"><Label htmlFor="wa-profile-email">Email</Label><Counter value={form.email} max={WA_PROFILE_LIMITS.email} /></div>
          <Input id="wa-profile-email" type="email" value={form.email} maxLength={WA_PROFILE_LIMITS.email} disabled={readOnly} onChange={(e) => set({ email: e.target.value })} data-testid="wa-profile-email" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i}>
              <Label htmlFor={`wa-profile-website-${i}`}>Website {i + 1}</Label>
              <Input id={`wa-profile-website-${i}`} type="url" placeholder="https://" value={form.websites[i] ?? ""} maxLength={WA_PROFILE_LIMITS.website} disabled={readOnly} onChange={(e) => setSite(i, e.target.value)} data-testid={`wa-profile-website-${i}`} />
            </div>
          ))}
        </div>
        {isAdmin && (
          <div className="flex justify-end">
            <Button type="submit" disabled={!dirty || saving} data-testid="wa-profile-save">
              {saving ? (<><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Saving…</>) : "Save"}
            </Button>
          </div>
        )}
      </form>
      {/* Outside the <form>: React bubbles the picker's own submit events
          through the portal, which would otherwise save this profile. */}
      {isAdmin && (
        <MediaPickerDialog
          subAccountId={subAccountId}
          canManage={isAdmin}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          accept="image"
          onSelect={(asset) =>
            void sendPhoto({
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mediaId: asset.id }),
            })
          }
        />
      )}
      <PhonePreview profile={form} verifiedName={phone.verifiedName} displayPhoneNumber={phone.displayPhoneNumber} />
    </div>
  );
}
