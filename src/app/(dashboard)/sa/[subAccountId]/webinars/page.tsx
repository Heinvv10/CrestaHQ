"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  MonitorPlay,
  Plus,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContactPicker } from "@/components/quotes/contact-picker";
import { useSubAccount } from "@/context/sub-account-context";
import { useSubAccountContacts } from "@/context/contacts-context";
import type { Contact } from "@/types/contacts";
import type { Webinar1Video, Webinar1Webinar } from "@/types/webinar1";

/**
 * Webinars — the CRM face of the Webinar1 integration. Lists the connected
 * deployment's webinars (via the server proxy; the API key never reaches the
 * browser), creates new ones against already-uploaded videos, and pushes CRM
 * contacts into a webinar (Webinar1 then runs the whole email sequence).
 * Registrations + attendance sync back onto contact timelines through the
 * inbound webhook — nothing to do here for that.
 */

const SCHEDULE_MODES = [
  {
    value: "just_in_time",
    label: "Just-in-time (next slot in minutes)",
  },
  { value: "on_demand", label: "On demand (instant access)" },
] as const;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export default function WebinarsPage() {
  const { subAccountId, subAccount, isAdmin, saPath } = useSubAccount();
  // Agency gate — same model as Website: the sidebar entry is hidden or
  // Locked while off, and this page (still reachable by URL) shows the
  // locked notice instead of the feature. The API routes 403 regardless.
  const gateOn = subAccount?.webinar1EnabledByAgency === true;
  const connected = !!subAccount?.webinar1ConnectionMeta;

  const [webinars, setWebinars] = useState<Webinar1Webinar[]>([]);
  const [videos, setVideos] = useState<Webinar1Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { contacts } = useSubAccountContacts();
  const [createOpen, setCreateOpen] = useState(false);
  const [registerFor, setRegisterFor] = useState<Webinar1Webinar | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [wRes, vRes] = await Promise.all([
        fetch(`/api/sub-accounts/${subAccountId}/webinar1/webinars`),
        fetch(`/api/sub-accounts/${subAccountId}/webinar1/videos`),
      ]);
      const wData = (await wRes.json().catch(() => ({}))) as {
        webinars?: Webinar1Webinar[];
        error?: string;
      };
      const vData = (await vRes.json().catch(() => ({}))) as {
        videos?: Webinar1Video[];
      };
      if (!wRes.ok) {
        throw new Error(wData.error ?? "Couldn't load webinars.");
      }
      setWebinars(wData.webinars ?? []);
      setVideos(vData.videos ?? []);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Couldn't load webinars."
      );
    } finally {
      setLoading(false);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!gateOn || !connected) {
      setLoading(false);
      return;
    }
    void load();
  }, [gateOn, connected, load]);

  const videoTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const v of videos) map[v.id] = v.title;
    return map;
  }, [videos]);

  // Sub-account doc still loading — don't flash the locked/connect states.
  if (!subAccount) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <PageHeading />
        <div className="flex items-center justify-center rounded-2xl border py-16">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      </div>
    );
  }

  if (!gateOn) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <PageHeading />
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
          <Lock className="text-muted-foreground h-6 w-6" />
          <p className="text-sm font-medium">Webinars are locked</p>
          <p className="text-muted-foreground max-w-md text-xs">
            This feature isn&apos;t enabled for this workspace. Ask your agency
            to turn it on.
          </p>
        </div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <PageHeading />
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
          <MonitorPlay className="text-muted-foreground h-6 w-6" />
          <p className="text-sm font-medium">No webinar platform connected</p>
          <p className="text-muted-foreground max-w-md text-xs">
            Connect a Webinar1 deployment to create evergreen webinars from
            here, push contacts into them, and see registrations + attendance on
            contact timelines.
          </p>
          {isAdmin ? (
            <Button
              size="sm"
              render={<Link href={saPath("/dashboard/settings")} />}
            >
              Connect in Settings
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              Ask a workspace admin to connect one under Settings → Admin.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading />
        {isAdmin && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New webinar
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center rounded-2xl border py-16">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      ) : loadError ? (
        <div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {loadError}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : webinars.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
          <MonitorPlay className="text-muted-foreground h-6 w-6" />
          <p className="text-sm font-medium">No webinars yet</p>
          <p className="text-muted-foreground max-w-md text-xs">
            Upload and process a video in the Webinar1 admin first, then create
            a webinar here against it.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {webinars.map((w) => (
            <li
              key={w.id}
              className="bg-card flex flex-wrap items-start justify-between gap-3 rounded-2xl border p-5"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">{w.title}</h2>
                  <span
                    className={
                      w.isActive
                        ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-700 uppercase dark:text-emerald-400"
                        : "bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase"
                    }
                  >
                    {w.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  /{w.slug} · {w.scheduleMode.replace(/_/g, " ")}
                  {w.videoId
                    ? ` · ${videoTitles[w.videoId] ?? "video attached"}`
                    : " · no video yet"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRegisterFor(w)}
                  disabled={!w.isActive}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Register contact
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(w.url);
                    toast.success("Registration link copied");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy link
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  render={<a href={w.url} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CreateWebinarDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        subAccountId={subAccountId}
        videos={videos}
        onCreated={() => void load()}
      />

      <RegisterContactDialog
        webinar={registerFor}
        onOpenChange={(open) => {
          if (!open) setRegisterFor(null);
        }}
        subAccountId={subAccountId}
        contacts={contacts}
      />
    </div>
  );
}

function PageHeading() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Webinars</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Evergreen webinars on your connected Webinar1 deployment. Registrations
        and attendance sync back onto contact timelines automatically.
      </p>
    </div>
  );
}

const selectClasses =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function CreateWebinarDialog({
  open,
  onOpenChange,
  subAccountId,
  videos,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subAccountId: string;
  videos: Webinar1Video[];
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [videoId, setVideoId] = useState("");
  const [scheduleMode, setScheduleMode] = useState<string>("just_in_time");
  const [saving, setSaving] = useState(false);

  const readyVideos = videos.filter((v) => v.status === "ready");

  useEffect(() => {
    if (open) {
      setTitle("");
      setSlug("");
      setSlugTouched(false);
      setVideoId("");
      setScheduleMode("just_in_time");
    }
  }, [open]);

  async function handleCreate() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/webinar1/webinars`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            slug: slug.trim(),
            videoId: videoId || null,
            scheduleMode,
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        webinar?: Webinar1Webinar;
        error?: string;
      };
      if (!res.ok || !data.webinar) {
        throw new Error(data.error ?? "Couldn't create the webinar.");
      }
      toast.success(`Webinar created — ${data.webinar.url}`);
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't create the webinar."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New webinar</DialogTitle>
          <DialogDescription>
            Creates the webinar on your Webinar1 deployment with sensible
            defaults. Fine-tune everything else (CTA, chat script, emails) in
            the Webinar1 admin.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="nw-title">Title</Label>
            <Input
              id="nw-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="How we tripled bookings in 90 days"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nw-slug">URL slug</Label>
            <Input
              id="nw-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="tripled-bookings"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-[11px]">
              Lowercase letters, numbers, and hyphens. Becomes the public page:
              /w/{slug || "your-slug"}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nw-video">Video</Label>
            <select
              id="nw-video"
              value={videoId}
              onChange={(e) => setVideoId(e.target.value)}
              className={selectClasses}
            >
              <option value="">Attach later in the Webinar1 admin</option>
              {readyVideos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-[11px]">
              Only processed (&ldquo;ready&rdquo;) videos are listed — upload
              new ones in the Webinar1 admin.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nw-mode">Scheduling</Label>
            <select
              id="nw-mode"
              value={scheduleMode}
              onChange={(e) => setScheduleMode(e.target.value)}
              className={selectClasses}
            >
              {SCHEDULE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreate()}
              disabled={saving || !title.trim() || !slug.trim()}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create webinar"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RegisterContactDialog({
  webinar,
  onOpenChange,
  subAccountId,
  contacts,
}: {
  webinar: Webinar1Webinar | null;
  onOpenChange: (open: boolean) => void;
  subAccountId: string;
  contacts: Contact[];
}) {
  const [contactId, setContactId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (webinar) setContactId("");
  }, [webinar]);

  // Registration is an email sequence — contacts without an address (or who
  // opted out) can't be pushed, so don't offer them.
  const eligible = useMemo(
    () => contacts.filter((c) => c.email && !c.emailOptedOut),
    [contacts]
  );

  async function handleRegister() {
    if (!webinar) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/webinar1/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId, webinarId: webinar.id }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        alreadyRegistered?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't register the contact.");
      }
      toast.success(
        data.alreadyRegistered
          ? "Already registered for this webinar."
          : "Registered — Webinar1 takes it from here (confirmation + reminders)."
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't register the contact."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!webinar} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Register a contact</DialogTitle>
          <DialogDescription>
            {webinar
              ? `Push a contact into "${webinar.title}". They'll get the full email sequence from the webinar platform.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reg-contact">Contact</Label>
            <ContactPicker
              id="reg-contact"
              contacts={eligible}
              value={contactId}
              onChange={setContactId}
              title="Pick a contact"
            />
            <p className="text-muted-foreground text-[11px]">
              Only contacts with an email address who haven&apos;t opted out are
              listed.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void handleRegister()}
              disabled={saving || !contactId}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Registering…
                </>
              ) : (
                "Register"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
