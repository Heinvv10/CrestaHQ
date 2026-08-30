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
import { Loader2, Instagram, Lock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import {
  metaCanInbox,
  metaCanInstagramDm,
} from "@/lib/comms/meta-capabilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AiAgentProfile, AiChannelConfig } from "@/types/ai";

/**
 * Messenger + Instagram DM AI settings — ONE channel ("meta") covering both
 * platforms, because they ride one Meta connection and the bot always
 * replies on whichever platform the DM arrived on. Mirrors the WhatsApp
 * channel section's shape.
 *
 * Gates beyond the shared persona requirement:
 *   - Agency inbox gate (`metaInboxEnabledByAgency`): the DMs must exist.
 *   - Agency AI gate (`metaAgentEnabledByAgency`): the bot spends the
 *     agency's shared OpenRouter credits, so it's separately opt-in.
 *   - A connected Meta Page (Settings → Facebook & Instagram).
 *   - Instagram additionally needs the `instagram_manage_messages` scope on
 *     the stored token — WITHOUT it the bot still answers Messenger; the
 *     amber hint explains how to add Instagram.
 */
export function MetaChannelSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();

  const [profile, setProfile] = useState<AiAgentProfile | null>(null);
  const [config, setConfig] = useState<AiChannelConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [contextCount, setContextCount] = useState(10);
  const [modelOverride, setModelOverride] = useState("");
  const [overrideKeywords, setOverrideKeywords] = useState(false);
  const [keywordsText, setKeywordsText] = useState("");
  const [overrideEmail, setOverrideEmail] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState("");

  const [saving, setSaving] = useState(false);

  const inboxGateOn = subAccount?.metaInboxEnabledByAgency === true;
  const agentGateOn = subAccount?.metaAgentEnabledByAgency === true;

  const hydrate = useCallback(async () => {
    setLoaded(false);
    try {
      const [profileRes, channelRes] = await Promise.all([
        fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`),
        fetch(`/api/sub-accounts/${subAccountId}/ai-agent/channels/meta`),
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
        setContextCount(channelData.config.contextMessageCount);
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
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Couldn't load Messenger & Instagram config: ${msg}`);
    } finally {
      setLoaded(true);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!isAdmin) return;
    void hydrate();
  }, [isAdmin, hydrate]);

  const totalTokens = useMemo(
    () => config?.totalTokensUsed ?? 0,
    [config?.totalTokensUsed],
  );

  if (!isAdmin) return null;

  const metaConnected = metaCanInbox(subAccount?.metaConfig);
  const instagramReady = metaCanInstagramDm(subAccount?.metaConfig);
  const igLinked = !!subAccount?.metaConfig?.instagramBusinessAccountId;
  const profileReady = !!profile?.systemPrompt?.trim();

  // Either agency gate off → locked card (mirrors the WhatsApp pattern).
  if (!inboxGateOn || !agentGateOn) {
    return (
      <section className="rounded-2xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Lock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold">
              Messenger &amp; Instagram AI
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {!inboxGateOn
                ? "The Facebook & Instagram inbox is locked for this sub-account. Your agency controls whether it's available — ask your agency owner to enable the inbox (and the Messenger & Instagram AI) from the sub-account's Manage panel."
                : "The Messenger & Instagram AI is locked for this sub-account. The inbox is on, but AI auto-replies are a separate switch — ask your agency owner to enable the Messenger & Instagram AI from the sub-account's Manage panel."}
            </p>
          </div>
        </div>
      </section>
    );
  }

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

      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/ai-agent/channels/meta`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            contextMessageCount: contextCount,
            modelOverride: modelOverride.trim() || null,
            escalationKeywordsOverride: overrideKeywords ? keywords : null,
            escalationNotifyEmailOverride: overrideEmail ? email : null,
          }),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        config?: AiChannelConfig;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save Messenger & Instagram settings");
        return;
      }
      if (data.config) setConfig(data.config);
      toast.success("Messenger & Instagram channel saved");
    } catch {
      toast.error("Network error — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-pink-500/10 text-pink-600 dark:text-pink-400">
          <Instagram className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-base font-semibold">
            Messenger &amp; Instagram AI
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One switch covers both platforms — the bot replies on whichever
            channel the DM arrived on. Persona, hours, and default escalation
            live on the{" "}
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

      {!metaConnected && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-400">
          <strong>Connect a Facebook Page first.</strong> The bot needs the
          shared Meta connection — set it up under{" "}
          <Link
            href={`/sa/${subAccountId}/dashboard/settings`}
            className="underline-offset-2 hover:underline"
          >
            Settings → Facebook &amp; Instagram
          </Link>
          .
        </div>
      )}

      {metaConnected && igLinked && !instagramReady && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-400">
          <strong>Messenger only for now.</strong> The connection&apos;s token
          doesn&apos;t carry the Instagram messaging permission, so the bot
          will answer Messenger DMs but skip Instagram. Click Reconnect under{" "}
          <Link
            href={`/sa/${subAccountId}/dashboard/settings`}
            className="underline-offset-2 hover:underline"
          >
            Settings → Facebook &amp; Instagram
          </Link>{" "}
          and approve Instagram access to cover both.
        </div>
      )}

      {!profileReady && loaded && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-400">
          <strong>Set the agent persona first.</strong> The toggle will be
          rejected until you save a persona prompt on the{" "}
          <Link
            href={`/sa/${subAccountId}/ai-agents`}
            className="underline-offset-2 hover:underline"
          >
            Overview
          </Link>
          .
        </div>
      )}

      <div className="mt-4 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
        The AI replies to inbound DMs within Meta&apos;s 24-hour messaging
        window (always open for a just-received message). Replying manually
        from the inbox pauses the bot on that conversation, and each
        conversation&apos;s AI controls (auto / suggest / off) apply here too.
      </div>

      {!loaded ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <form className="mt-6 space-y-5" onSubmit={handleSave}>
          <label className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
            <div>
              <p className="text-sm font-medium">
                Enable Messenger &amp; Instagram auto-replies
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                When on, inbound Messenger and Instagram DMs get an AI
                response in real time.
              </p>
            </div>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 cursor-pointer"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="meta-context-count">Context messages (1-50)</Label>
              <Input
                id="meta-context-count"
                type="number"
                min={1}
                max={50}
                value={contextCount}
                onChange={(e) => setContextCount(Number(e.target.value) || 10)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="meta-model">
                Model (advanced — blank for default)
              </Label>
              <Input
                id="meta-model"
                value={modelOverride}
                onChange={(e) => setModelOverride(e.target.value)}
                placeholder="anthropic/claude-haiku-4-5"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Default model: Claude Haiku 4.5. Override with{" "}
            <code>anthropic/claude-opus-4-7</code> for premium quality at ~50×
            the cost. Any OpenRouter model id works.
          </p>

          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={overrideKeywords}
                onChange={(e) => setOverrideKeywords(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Override default escalation keywords for Messenger &amp; Instagram
            </label>
            {overrideKeywords ? (
              <Input
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
                placeholder="manager, human, complaint, stop ai"
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
              Override escalation notification email for Messenger &amp;
              Instagram
            </label>
            {overrideEmail ? (
              <Input
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="dm-escalations@example.com"
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

          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-muted-foreground">
              Lifetime tokens used on Messenger &amp; Instagram:{" "}
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
                "Save Messenger & Instagram settings"
              )}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
