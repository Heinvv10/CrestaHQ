"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, Inbox, Loader2, Lock, PhoneCall } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToBookingPages } from "@/lib/firestore/booking-pages";
import { pageCalendarType } from "@/lib/booking/calendar-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  AiAgentProfile,
  AiChannelConfig,
  VoiceChannelConfig,
  VoiceNumberMode,
} from "@/types/ai";
import { DEFAULT_VOICE_CONFIG } from "@/types/ai";
import type { BookingPage } from "@/types/booking";

/**
 * Voice channel operational settings. Mirrors SmsChannelSection's shape
 * but with voice-specific fields (greeting, voiceProvider, voiceId,
 * maxCallSeconds). Persona itself lives on the AI Agent profile and
 * applies across SMS, Web Chat, and Voice without duplication.
 *
 * Two gates surface as amber banners when not met (enable toggle is
 * still allowed — the API enforces hard):
 *   1. Dedicated Twilio number configured (same gate as SMS — voice
 *      attaches to the same number via Vapi BYOC).
 *   2. Agent persona prompt non-empty on the profile.
 */

// Native option lists inherit the parent select's background — using
// `bg-transparent` makes the popup unreadable in dark themes (greyish
// text on whatever shows through). Set explicit bg + text on the
// select AND on nested `option` so the popup is high-contrast in both
// light and dark. Mirrors the pattern in agent-profile-section.tsx.
const NATIVE_SELECT_CLASSES =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground";

// Preset voices are OpenAI-only ON PURPOSE: OpenAI voice names are literal,
// stable TTS API constants Vapi resolves with no operator-side provider key.
// The previous ElevenLabs presets (burt/andrea/rohan/lily) were Vapi preset
// NAMES that no longer resolve — assistant creation 400s with "Couldn't Find
// 11labs Voice" (real ElevenLabs voice ids are opaque hashes, and
// custom/cloned voices additionally need the operator's ElevenLabs key in
// Vapi → Provider Keys). ElevenLabs stays available via the custom voice-ID
// option below, so we never ship a hardcoded id we can't verify.
const VOICE_OPTIONS: Array<{
  provider: string;
  voiceId: string;
  label: string;
}> = [
  { provider: "openai", voiceId: "alloy", label: "OpenAI — Alloy (neutral)" },
  { provider: "openai", voiceId: "echo", label: "OpenAI — Echo (calm, male)" },
  { provider: "openai", voiceId: "fable", label: "OpenAI — Fable (expressive)" },
  { provider: "openai", voiceId: "onyx", label: "OpenAI — Onyx (deep, male)" },
  { provider: "openai", voiceId: "nova", label: "OpenAI — Nova (warm, female)" },
  { provider: "openai", voiceId: "shimmer", label: "OpenAI — Shimmer (bright, female)" },
];

/** Sentinel select value for the "paste your own ElevenLabs voice id" mode.
 *  Has no colon so it can never collide with a real `provider:voiceId` key. */
const CUSTOM_VOICE_KEY = "custom";

function voiceKey(provider: string, voiceId: string): string {
  return `${provider}:${voiceId}`;
}

export function VoiceChannelSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();

  const [profile, setProfile] = useState<AiAgentProfile | null>(null);
  const [config, setConfig] = useState<AiChannelConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [greeting, setGreeting] = useState(DEFAULT_VOICE_CONFIG.greeting);
  const [selectedVoice, setSelectedVoice] = useState(
    voiceKey(DEFAULT_VOICE_CONFIG.voiceProvider, DEFAULT_VOICE_CONFIG.voiceId),
  );
  const [customVoiceId, setCustomVoiceId] = useState("");
  // Custom-voice provider + optional model/version. Previously the custom
  // path hardcoded "11labs", so a non-ElevenLabs voice hydrated into custom
  // mode was silently rewritten as a broken ElevenLabs id on the next save.
  const [customVoiceProvider, setCustomVoiceProvider] = useState("11labs");
  const [customVoiceVersion, setCustomVoiceVersion] = useState("");
  // Explicit transcriber ("" = Vapi default — sends no block).
  const [transcriberProvider, setTranscriberProvider] = useState("");
  const [transcriberModel, setTranscriberModel] = useState("");
  const [maxCallSeconds, setMaxCallSeconds] = useState(
    DEFAULT_VOICE_CONFIG.maxCallSeconds,
  );
  const [bookingPageSlug, setBookingPageSlug] = useState("");
  const [bookingPages, setBookingPages] = useState<BookingPage[]>([]);
  const [numberMode, setNumberMode] = useState<VoiceNumberMode>(
    DEFAULT_VOICE_CONFIG.numberMode,
  );
  const [vapiNumberId, setVapiNumberId] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [overrideKeywords, setOverrideKeywords] = useState(false);
  const [keywordsText, setKeywordsText] = useState("");
  const [overrideEmail, setOverrideEmail] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState("");

  const [saving, setSaving] = useState(false);

  const hydrate = useCallback(async () => {
    setLoaded(false);
    try {
      const [profileRes, channelRes] = await Promise.all([
        fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`),
        fetch(`/api/sub-accounts/${subAccountId}/ai-agent/channels/voice`),
      ]);
      const profileData = (await profileRes.json()) as {
        profile: AiAgentProfile | null;
      };
      const channelData = (await channelRes.json()) as {
        config: AiChannelConfig | null;
      };
      setProfile(profileData.profile);
      setConfig(channelData.config);

      if (channelData.config) {
        setEnabled(channelData.config.enabled);
        setModelOverride(channelData.config.modelOverride ?? "");
        setOverrideKeywords(
          channelData.config.escalationKeywordsOverride !== null,
        );
        setKeywordsText(
          (channelData.config.escalationKeywordsOverride ?? []).join(", "),
        );
        setOverrideEmail(
          channelData.config.escalationNotifyEmailOverride !== null,
        );
        setNotifyEmail(channelData.config.escalationNotifyEmailOverride ?? "");

        const v: VoiceChannelConfig =
          channelData.config.voice ?? DEFAULT_VOICE_CONFIG;
        setGreeting(v.greeting);
        setBookingPageSlug(v.bookingPageSlug ?? "");
        // A stored voice that isn't one of our presets (a pasted ElevenLabs
        // id — or a legacy 11labs preset name like "burt" that Vapi no
        // longer resolves) hydrates into custom mode so the operator can see
        // and fix the raw id.
        const storedKey = voiceKey(v.voiceProvider, v.voiceId);
        if (VOICE_OPTIONS.some((o) => voiceKey(o.provider, o.voiceId) === storedKey)) {
          setSelectedVoice(storedKey);
          setCustomVoiceId("");
          setCustomVoiceProvider("11labs");
          setCustomVoiceVersion("");
        } else {
          setSelectedVoice(CUSTOM_VOICE_KEY);
          setCustomVoiceId(v.voiceId);
          // Round-trip the STORED provider — hydrating a Vapi-dashboard
          // voice into custom mode must not rewrite it as ElevenLabs.
          setCustomVoiceProvider(v.voiceProvider || "11labs");
          setCustomVoiceVersion(v.voiceVersion ?? "");
        }
        setTranscriberProvider(v.transcriberProvider ?? "");
        setTranscriberModel(v.transcriberModel ?? "");
        setMaxCallSeconds(v.maxCallSeconds);
        setNumberMode(v.numberMode);
        // Only surface the pasted id when the operator picked
        // vapi-managed — in BYOC mode the id is server-managed and
        // showing it would just confuse them.
        setVapiNumberId(
          v.numberMode === "vapi-managed" ? v.vapiPhoneNumberId ?? "" : "",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Couldn't load voice config: ${msg}`);
    } finally {
      setLoaded(true);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!isAdmin) return;
    void hydrate();
  }, [isAdmin, hydrate]);

  // Booking pages for the live-booking picker. Live subscription so a page
  // published in another tab appears without a refresh.
  useEffect(() => {
    if (!isAdmin || !subAccountId) return;
    const unsub = subscribeToBookingPages(
      subAccountId,
      setBookingPages,
      () => {},
    );
    return () => unsub();
  }, [isAdmin, subAccountId]);

  const totalTokens = useMemo(
    () => config?.totalTokensUsed ?? 0,
    [config?.totalTokensUsed],
  );

  if (!isAdmin) return null;

  // Agency gate locked state — inbound Voice spends Vapi minutes + OpenRouter
  // tokens, so the agency owner controls availability (like outbound).
  if (subAccount?.inboundVoiceEnabledByAgency === false) {
    return (
      <section className="rounded-2xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Lock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Inbound Voice AI</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Inbound Voice is locked for this sub-account. Your agency controls
              whether it&apos;s available — ask your agency owner to enable
              Inbound Voice AI from the sub-account&apos;s Manage panel.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const dedicatedTwilioConfigured = !!subAccount?.twilioConfig?.enabled;
  const profileReady = !!profile?.systemPrompt?.trim();
  const linkedAssistantId = config?.voice?.vapiAssistantId ?? null;
  const linkedPhoneNumberId = config?.voice?.vapiPhoneNumberId ?? null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const keywords = overrideKeywords
        ? keywordsText
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : null;

      const email = overrideEmail ? notifyEmail.trim() || null : null;

      let voiceProvider: string;
      let voiceId: string;
      if (selectedVoice === CUSTOM_VOICE_KEY) {
        voiceProvider = customVoiceProvider;
        voiceId = customVoiceId.trim();
        if (!voiceId) {
          toast.error(
            "Paste a voice ID (from Vapi's voice library), or pick a preset voice.",
          );
          setSaving(false);
          return;
        }
      } else {
        [voiceProvider, voiceId] = selectedVoice.split(":");
      }

      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/ai-agent/channels/voice`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            modelOverride: modelOverride.trim() || null,
            escalationKeywordsOverride: overrideKeywords ? keywords : null,
            escalationNotifyEmailOverride: overrideEmail ? email : null,
            voice: {
              greeting: greeting.trim() || DEFAULT_VOICE_CONFIG.greeting,
              voiceProvider,
              voiceId,
              voiceVersion:
                selectedVoice === CUSTOM_VOICE_KEY
                  ? customVoiceVersion.trim() || null
                  : null,
              transcriberProvider: transcriberProvider || null,
              transcriberModel: transcriberProvider
                ? transcriberModel.trim() || null
                : null,
              maxCallSeconds,
              bookingPageSlug: bookingPageSlug || null,
              numberMode,
              // Only the pasted id is meaningful, and only in vapi-managed
              // mode. In BYOC mode the id is server-managed: the API now
              // preserves the stored id on a re-save (and only clears it on
              // a mode switch), so the `null` we send here can't wipe it.
              vapiPhoneNumberId:
                numberMode === "vapi-managed"
                  ? vapiNumberId.trim() || null
                  : null,
            },
          }),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        config?: AiChannelConfig;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save voice settings");
        return;
      }
      if (data.config) setConfig(data.config);
      toast.success(
        enabled
          ? "Voice channel saved — Vapi assistant synced"
          : "Voice channel saved",
      );
    } catch {
      toast.error("Network error — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <PhoneCall className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Voice channel</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              AI answers inbound phone calls, qualifies the caller, and
              books a callback. Persona and KB are shared with SMS + Web
              Chat —{" "}
              <Link
                href={`/sa/${subAccountId}/ai-agents`}
                className="text-foreground underline-offset-2 hover:underline"
              >
                Overview
              </Link>
              .
            </p>
          </div>
        </div>
        <Link
          href={`/sa/${subAccountId}/ai-agents/voice/calls`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
        >
          <Inbox className="h-3.5 w-3.5" />
          Calls
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {numberMode === "twilio-byoc" && !dedicatedTwilioConfigured && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-400">
          <strong>Heads up:</strong> BYOC mode attaches to your
          dedicated Twilio number. Configure one in{" "}
          <Link
            href={`/sa/${subAccountId}/dashboard/settings`}
            className="underline-offset-2 hover:underline"
          >
            Settings → SMS
          </Link>{" "}
          first, or switch to a Vapi-managed number below.
        </div>
      )}

      {!profileReady && loaded && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-400">
          <strong>Set the agent persona first.</strong> The voice toggle
          will be rejected until you save a persona prompt on the{" "}
          <Link
            href={`/sa/${subAccountId}/ai-agents`}
            className="underline-offset-2 hover:underline"
          >
            Overview
          </Link>
          .
        </div>
      )}

      {!loaded ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <form className="mt-6 space-y-5" onSubmit={handleSave}>
          <label className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
            <div>
              <p className="text-sm font-medium">Enable voice agent</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                When on, inbound calls to the configured number are
                answered by the AI via Vapi. The agent qualifies the
                caller, captures their details, and books a human
                callback if needed.
              </p>
            </div>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 cursor-pointer"
            />
          </label>

          <fieldset className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <legend className="px-1 text-sm font-medium">
              Phone number source
            </legend>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 hover:bg-muted/40">
              <input
                type="radio"
                name="voice-number-mode"
                value="twilio-byoc"
                checked={numberMode === "twilio-byoc"}
                onChange={() => setNumberMode("twilio-byoc")}
                className="mt-1 h-3.5 w-3.5 cursor-pointer"
              />
              <div className="text-xs">
                <p className="font-medium text-foreground">
                  My dedicated Twilio number (BYOC){" "}
                  <span className="font-normal text-muted-foreground">
                    — production
                  </span>
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  Voice attaches to the same Twilio number this
                  sub-account uses for SMS. One number, one bill. Needs
                  Settings → SMS configured.
                </p>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 hover:bg-muted/40">
              <input
                type="radio"
                name="voice-number-mode"
                value="vapi-managed"
                checked={numberMode === "vapi-managed"}
                onChange={() => setNumberMode("vapi-managed")}
                className="mt-1 h-3.5 w-3.5 cursor-pointer"
              />
              <div className="text-xs">
                <p className="font-medium text-foreground">
                  A number I own in Vapi{" "}
                  <span className="font-normal text-muted-foreground">
                    — testing / skip Twilio regulatory
                  </span>
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  Skip AU regulatory bundles by attaching to a number
                  you provisioned directly in your Vapi dashboard.
                  We&apos;ll bind it to a LeadStack-managed assistant —
                  any previously-assigned assistant will be replaced.
                </p>
              </div>
            </label>

            {numberMode === "vapi-managed" && (
              <div className="space-y-1.5 pt-1">
                <Label htmlFor="voice-vapi-number-id">
                  Vapi phone number ID
                </Label>
                <Input
                  id="voice-vapi-number-id"
                  value={vapiNumberId}
                  onChange={(e) => setVapiNumberId(e.target.value)}
                  placeholder="70740329-cb3b-4f22-bbfa-0527…"
                  maxLength={120}
                />
                <p className="text-[11px] text-muted-foreground">
                  Find it under{" "}
                  <a
                    href="https://dashboard.vapi.ai/phone-numbers"
                    target="_blank"
                    rel="noreferrer"
                    className="underline-offset-2 hover:underline"
                  >
                    Vapi dashboard → Phone Numbers
                  </a>{" "}
                  — copy the UUID under the number, not the +1 / +61
                  number itself.
                </p>
              </div>
            )}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="voice-greeting">First-message greeting</Label>
            <Input
              id="voice-greeting"
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              placeholder={DEFAULT_VOICE_CONFIG.greeting}
              maxLength={400}
            />
            <p className="text-[11px] text-muted-foreground">
              The very first sentence Vapi speaks when the call connects.
              Keep it short and natural — long greetings feel robotic.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="voice-voice">Voice</Label>
              <select
                id="voice-voice"
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className={NATIVE_SELECT_CLASSES}
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={voiceKey(v.provider, v.voiceId)} value={voiceKey(v.provider, v.voiceId)}>
                    {v.label}
                  </option>
                ))}
                <option value={CUSTOM_VOICE_KEY}>
                  Custom voice (paste an ID)…
                </option>
              </select>
              {selectedVoice === CUSTOM_VOICE_KEY && (
                <div className="space-y-1.5">
                  <select
                    id="voice-custom-provider"
                    value={customVoiceProvider}
                    onChange={(e) => setCustomVoiceProvider(e.target.value)}
                    className={NATIVE_SELECT_CLASSES}
                    aria-label="Custom voice provider"
                  >
                    {["11labs", "vapi", "openai", "playht", "deepgram", "azure", "cartesia"].map(
                      (p) => (
                        <option key={p} value={p}>
                          {p === "11labs" ? "ElevenLabs" : p}
                        </option>
                      ),
                    )}
                  </select>
                  <Input
                    id="voice-custom-id"
                    value={customVoiceId}
                    onChange={(e) => setCustomVoiceId(e.target.value)}
                    placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
                    maxLength={120}
                  />
                  <Input
                    id="voice-custom-version"
                    value={customVoiceVersion}
                    onChange={(e) => setCustomVoiceVersion(e.target.value)}
                    placeholder="Model/version (optional — blank = provider default)"
                    maxLength={80}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Paste a voice ID confirmed in Vapi&apos;s voice library
                    (dashboard.vapi.ai → Voice Library), with its provider.
                    Custom/cloned voices also need that provider&apos;s API key
                    under Vapi → Provider Keys. Without a model/version the
                    provider&apos;s default (often its oldest) is used.
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="voice-max-seconds">Max call duration (sec)</Label>
              <Input
                id="voice-max-seconds"
                type="number"
                min={60}
                max={1800}
                value={maxCallSeconds}
                onChange={(e) =>
                  setMaxCallSeconds(
                    Number(e.target.value) || DEFAULT_VOICE_CONFIG.maxCallSeconds,
                  )
                }
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="voice-transcriber">Transcriber (STT)</Label>
              <select
                id="voice-transcriber"
                value={transcriberProvider}
                onChange={(e) => setTranscriberProvider(e.target.value)}
                className={NATIVE_SELECT_CLASSES}
              >
                <option value="">Vapi default (recommended)</option>
                <option value="deepgram">Deepgram</option>
                <option value="assembly-ai">AssemblyAI</option>
                <option value="azure">Azure</option>
              </select>
              <p className="text-[11px] text-muted-foreground">
                Stored here so a Vapi-side re-create can&apos;t silently reset
                it. Leave on Vapi default unless you&apos;ve tuned STT.
              </p>
            </div>
            {transcriberProvider && (
              <div className="space-y-1.5">
                <Label htmlFor="voice-transcriber-model">
                  Transcriber model (optional)
                </Label>
                <Input
                  id="voice-transcriber-model"
                  value={transcriberModel}
                  onChange={(e) => setTranscriberModel(e.target.value)}
                  placeholder="e.g. nova-2 — blank = provider default"
                  maxLength={80}
                />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="voice-booking-page"
              className="flex items-center gap-2"
            >
              Live appointment booking
              <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
                Beta
              </span>
            </Label>
            <select
              id="voice-booking-page"
              value={bookingPageSlug}
              onChange={(e) => setBookingPageSlug(e.target.value)}
              className={NATIVE_SELECT_CLASSES}
            >
              <option value="">
                Off — the agent offers your booking link instead
              </option>
              {bookingPages
                .filter((p) => p.status === "published" && !p.payment)
                .map((p) =>
                  // A call has no service step, so the voice agent refuses
                  // service pages — shown, but not pickable.
                  pageCalendarType(p) === "service" ? (
                    <option key={p.slug} value={p.slug} disabled>
                      {p.name} — service page, not bookable by voice
                    </option>
                  ) : (
                    <option key={p.slug} value={p.slug}>
                      Book on: {p.name} ({p.durationMinutes} min)
                    </option>
                  ),
                )}
            </select>
            <p className="text-[11px] text-muted-foreground">
              When set, the agent checks live availability on that booking
              page and books the caller in during the call — offering up to
              three slots from the next 7 days. Bookings are phone-only
              (caller ID): no email is collected, so no confirmation email is
              sent — the appointment lands on the calendar and the normal
              booking triggers fire. Deposit-taking pages can&apos;t be
              booked by phone and aren&apos;t listed; service pages can&apos;t
              either (there&apos;s no service step on a call).
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="voice-model">Model (advanced — blank for default)</Label>
            <Input
              id="voice-model"
              value={modelOverride}
              onChange={(e) => setModelOverride(e.target.value)}
              placeholder="anthropic/claude-haiku-4-5"
            />
            <p className="text-[11px] text-muted-foreground">
              Default: Claude Haiku 4.5 — fast enough for sub-1s voice
              turns. Sonnet adds latency but reasons better; Opus is
              overkill for live calls.
            </p>
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={overrideKeywords}
                onChange={(e) => setOverrideKeywords(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Override default escalation keywords for voice
            </label>
            {overrideKeywords ? (
              <Input
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
                placeholder="manager, complaint, urgent"
              />
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Using profile defaults:{" "}
                <code className="text-foreground">
                  {profile?.escalationKeywords.join(", ") || "(none set)"}
                </code>
              </p>
            )}
          </div>

          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={overrideEmail}
                onChange={(e) => setOverrideEmail(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Override escalation notification email for voice
            </label>
            {overrideEmail ? (
              <Input
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="voice-callbacks@example.com"
              />
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Using profile default:{" "}
                <code className="text-foreground">
                  {profile?.escalationNotifyEmail || "(none set)"}
                </code>
              </p>
            )}
          </div>

          {(linkedAssistantId || linkedPhoneNumberId) && (
            <div className="rounded-lg border bg-muted/20 p-3 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground">Vapi linkage</p>
              {linkedAssistantId && (
                <p className="mt-1">
                  Assistant:{" "}
                  <code className="text-foreground">{linkedAssistantId}</code>
                </p>
              )}
              {linkedPhoneNumberId && (
                <p className="mt-0.5">
                  Phone number:{" "}
                  <code className="text-foreground">{linkedPhoneNumberId}</code>
                </p>
              )}
              <p className="mt-2">
                Saving re-syncs Vapi with the latest persona, KB, and
                voice settings. Disabling tears down both resources to
                stop Vapi spend.
              </p>
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-muted-foreground">
              Lifetime tokens used on voice:{" "}
              <span className="font-medium text-foreground">
                {totalTokens.toLocaleString()}
              </span>
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
      )}
    </section>
  );
}
