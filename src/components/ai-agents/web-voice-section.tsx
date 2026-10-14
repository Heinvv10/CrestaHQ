"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Lock,
  Mic,
  Play,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  WEB_VOICE_LANGUAGES,
  WEB_VOICE_LIMITS,
  type WebVoiceMeta,
} from "@/types/web-voice";

/**
 * Web Voice settings card (ElevenLabs Web Voice v1), shown under the Web
 * Chat channel settings. The sub-account admin pastes their OWN ElevenLabs
 * API key; LeadStack creates a private voice agent on that account and the
 * chat widget grows a mic button. Replies come from the same assistant as
 * typed chat. Plan: ELEVENLABS_WEB_VOICE_V1_PLAN.md.
 */

interface VoiceOption {
  voiceId: string;
  name: string;
  category: string | null;
  description: string | null;
  previewUrl: string | null;
}

interface StatusResponse {
  gateOn: boolean;
  webChatGateOn: boolean;
  meta: WebVoiceMeta | null;
  usage: { secondsToday: number; secondsThisMonth: number; activeNow: number } | null;
  voices: VoiceOption[];
  voicesError: string | null;
  previewToken: string | null;
}

const SELECT_CLASS =
  "flex h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground";

const CALL_LENGTH_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 30];

function minutes(seconds: number): string {
  const m = seconds / 60;
  return m < 10 ? m.toFixed(1) : Math.round(m).toString();
}

export function WebVoiceSection() {
  const { subAccountId, isAdmin } = useSubAccount();

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [showReplaceKey, setShowReplaceKey] = useState(false);

  const [enabled, setEnabled] = useState(true);
  const [voiceId, setVoiceId] = useState("");
  const [language, setLanguage] = useState("en");
  const [greeting, setGreeting] = useState("");
  const [maxCallMinutes, setMaxCallMinutes] = useState(5);
  const [dailyCap, setDailyCap] = useState(60);
  const [saving, setSaving] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const hydrateForm = useCallback((meta: WebVoiceMeta | null) => {
    if (!meta) return;
    setEnabled(meta.enabled !== false);
    setVoiceId(meta.voiceId);
    setLanguage(meta.language || "en");
    setGreeting(meta.greeting);
    setMaxCallMinutes(Math.max(1, Math.round(meta.maxCallSeconds / 60)));
    setDailyCap(meta.dailyMinuteCap);
  }, []);

  const applyMutationMeta = useCallback(
    (meta: WebVoiceMeta, voices?: VoiceOption[]) => {
      hydrateForm(meta);
      setStatus((current) =>
        current
          ? {
              ...current,
              meta,
              usage: null,
              previewToken: null,
              ...(voices ? { voices, voicesError: null } : {}),
            }
          : current,
      );
    },
    [hydrateForm],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/web-voice?voices=1`);
      const data = (await res.json()) as StatusResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't load voice settings");
      setStatus(data);
      hydrateForm(data.meta);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load voice settings");
    } finally {
      setLoading(false);
    }
  }, [subAccountId, hydrateForm]);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  const previewUrl = useMemo(() => {
    if (typeof window === "undefined" || !status?.previewToken) return null;
    return `${window.location.origin}/embed/chat/${subAccountId}?vt=${encodeURIComponent(status.previewToken)}`;
  }, [status?.previewToken, subAccountId]);

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setConnecting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/web-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = (await res.json()) as {
        meta: WebVoiceMeta;
        voices?: VoiceOption[];
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't connect ElevenLabs");
        return;
      }
      setApiKey("");
      setShowReplaceKey(false);
      applyMutationMeta(data.meta, data.voices);
      if (data.meta.ready) toast.success("ElevenLabs connected — voice is ready");
      else toast.warning(data.meta.lastError ?? "Connected, but the voice agent isn't ready yet");
      await load();
    } catch {
      toast.error("Network error — try again");
    } finally {
      setConnecting(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const voice = status?.voices.find((v) => v.voiceId === voiceId);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/web-voice`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          voiceId,
          ...(voice ? { voiceName: voice.name } : {}),
          language,
          greeting,
          maxCallSeconds: maxCallMinutes * 60,
          dailyMinuteCap: dailyCap,
        }),
      });
      const data = (await res.json()) as { meta: WebVoiceMeta; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't save voice settings");
        return;
      }
      applyMutationMeta(data.meta);
      if (data.meta.ready) toast.success("Voice settings saved");
      else toast.warning(data.meta.lastError ?? "Saved, but the voice agent needs attention");
      await load();
    } catch {
      toast.error("Network error — try again");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/web-voice`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Couldn't disconnect");
        return;
      }
      setStatus((current) =>
        current
          ? {
              ...current,
              meta: null,
              usage: null,
              voices: [],
              voicesError: null,
              previewToken: null,
            }
          : current,
      );
      toast.success("ElevenLabs disconnected — the mic is gone from the widget");
      setConfirmDisconnect(false);
      await load();
    } catch {
      toast.error("Network error — couldn't disconnect. Try again.");
    } finally {
      setDisconnecting(false);
    }
  }

  function playPreview() {
    const v = status?.voices.find((x) => x.voiceId === voiceId);
    if (!v?.previewUrl) {
      toast.message("No preview available for this voice");
      return;
    }
    void new Audio(v.previewUrl).play().catch(() => {
      toast.error("Couldn't play the preview");
    });
  }

  if (!isAdmin) return null;
  if (loading && !status) {
    return (
      <section className="mt-6 rounded-2xl border bg-card p-6">
        <p className="text-sm text-muted-foreground">Loading voice settings…</p>
      </section>
    );
  }
  if (!status || !status.webChatGateOn) return null;

  const header = (
    <div className="flex items-start gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
        <Mic className="h-4 w-4" />
      </span>
      <div>
        <h2 className="text-base font-semibold">Voice (ElevenLabs)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Let website visitors talk to the chat assistant out loud. Uses your
          own ElevenLabs account for the voice. Answers come from the same
          assistant, knowledge base and lead capture as typed chat.
        </p>
      </div>
    </div>
  );

  if (!status.gateOn) {
    return (
      <section className="mt-6 rounded-2xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Lock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Voice (ElevenLabs)</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Talking to the chat widget is locked for this sub-account. Ask
              your agency owner to enable Web Voice from the sub-account&apos;s
              Manage panel.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const meta = status.meta;

  // ── Not connected ────────────────────────────────────────────────────
  if (!meta) {
    return (
      <section className="mt-6 rounded-2xl border bg-card p-6">
        {header}
        <form className="mt-5 space-y-3" onSubmit={handleConnect}>
          <div className="space-y-1.5">
            <Label htmlFor="wv-key">ElevenLabs API key</Label>
            <Input
              id="wv-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk_…"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              In ElevenLabs go to Developers → API keys → Create key. Give it
              access to <strong>Text to Speech</strong>, <strong>Voices</strong>{" "}
              (read) and <strong>ElevenAgents</strong> (write). Voice minutes
              are billed by ElevenLabs to that account (about $0.08 per
              minute). Typed chat is unaffected.
            </p>
          </div>
          <Button type="submit" disabled={connecting || !apiKey.trim()}>
            {connecting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                <KeyRound className="h-3.5 w-3.5" />
                Connect ElevenLabs
              </>
            )}
          </Button>
        </form>
      </section>
    );
  }

  // ── Connected ────────────────────────────────────────────────────────
  const usage = status.usage;
  return (
    <section className="mt-6 rounded-2xl border bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        {header}
        {meta.ready ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {meta.enabled ? "Live" : "Ready (off)"}
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            Needs attention
          </span>
        )}
      </div>

      {meta.lastError && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-400">
          {meta.lastError}
        </div>
      )}

      {usage && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <p className="text-[11px] text-muted-foreground">Today (UTC)</p>
            <p className="text-sm font-semibold">
              {minutes(usage.secondsToday)} / {meta.dailyMinuteCap} min
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] text-muted-foreground">This month</p>
            <p className="text-sm font-semibold">{minutes(usage.secondsThisMonth)} min</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] text-muted-foreground">Talking now</p>
            <p className="text-sm font-semibold">{usage.activeNow}</p>
          </div>
        </div>
      )}

      <form className="mt-5 space-y-5" onSubmit={handleSave}>
        <div className="flex items-start gap-3 rounded-lg border p-4">
          <Checkbox id="wv-enabled" checked={enabled} onCheckedChange={(v) => setEnabled(!!v)} />
          <div className="flex-1">
            <Label htmlFor="wv-enabled" className="text-sm font-medium">
              Show the mic button in the chat widget
            </Label>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Turn off to hide voice without disconnecting ElevenLabs.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="wv-voice">Voice</Label>
            <div className="flex gap-2">
              <select
                id="wv-voice"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                className={SELECT_CLASS}
              >
                {!status.voices.some((v) => v.voiceId === voiceId) && voiceId && (
                  <option value={voiceId}>{meta.voiceName || voiceId}</option>
                )}
                {status.voices.map((v) => (
                  <option key={v.voiceId} value={v.voiceId}>
                    {v.name}
                    {v.description ? ` — ${v.description}` : ""}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={playPreview}
                aria-label="Play voice preview"
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            </div>
            {status.voicesError && (
              <p className="text-[11px] text-amber-600 dark:text-amber-500">
                Couldn&apos;t load your voices: {status.voicesError}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wv-lang">Language</Label>
            <select
              id="wv-lang"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className={SELECT_CLASS}
            >
              {WEB_VOICE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="wv-greeting">Spoken greeting</Label>
          <Textarea
            id="wv-greeting"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            rows={2}
            maxLength={WEB_VOICE_LIMITS.greetingMaxChars}
          />
          <p className="text-[11px] text-muted-foreground">
            The first thing the assistant says when a visitor taps the mic.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="wv-maxcall">Max length per conversation</Label>
            <select
              id="wv-maxcall"
              value={maxCallMinutes}
              onChange={(e) => setMaxCallMinutes(Number(e.target.value))}
              className={SELECT_CLASS}
            >
              {CALL_LENGTH_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} minute{m === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wv-cap">Daily limit (minutes)</Label>
            <Input
              id="wv-cap"
              type="number"
              min={WEB_VOICE_LIMITS.dailyMinuteCapMin}
              max={WEB_VOICE_LIMITS.dailyMinuteCapMax}
              value={dailyCap}
              onChange={(e) => setDailyCap(Number(e.target.value))}
            />
            <p className="text-[11px] text-muted-foreground">
              When reached, the mic hides until tomorrow (UTC). Typing keeps working.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-foreground">
            Key ending <span className="font-mono text-foreground">…{meta.keyLast4}</span>
          </p>
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save voice settings"
            )}
          </Button>
        </div>
      </form>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t pt-4">
        {previewUrl ? (
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Test voice in the widget
          </a>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            Turn on Web Chat and the mic button (and fix any error above) to test voice.
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowReplaceKey((v) => !v)}
        >
          <KeyRound className="h-3.5 w-3.5" />
          Replace key
        </Button>
        {confirmDisconnect ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={disconnecting}
              onClick={() => void handleDisconnect()}
            >
              {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Confirm disconnect
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDisconnect(true)}
          >
            Disconnect
          </Button>
        )}
      </div>

      {showReplaceKey && (
        <form className="mt-4 flex gap-2" onSubmit={handleConnect}>
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="New ElevenLabs API key"
            className="font-mono text-xs"
            aria-label="New ElevenLabs API key"
          />
          <Button type="submit" disabled={connecting || !apiKey.trim()}>
            {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save key"}
          </Button>
        </form>
      )}
    </section>
  );
}
