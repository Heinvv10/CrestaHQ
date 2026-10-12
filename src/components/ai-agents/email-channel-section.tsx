"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Lock, Mail } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import type { AiAgentProfile, AiChannelConfig } from "@/types/ai";

/**
 * Email AI settings — DRAFT-ONLY by design: the bot reads emails the connected
 * mailbox imports and stashes a suggested reply on the conversation for a
 * person to approve. It NEVER sends an email by itself, even when the
 * conversation's AI mode is "Auto".
 *
 * Prerequisites, in order:
 *   - Agency gate (`emailAiDraftsEnabledByAgency`).
 *   - A connected mailbox (Settings → Messaging → Email conversations) and
 *     email sending (Email provider) — the channels route checks both.
 *   - The shared persona prompt (AI Agents → Overview).
 */
export function EmailChannelSection() {
  const { subAccountId, subAccount, saPath, isAdmin, loading } = useSubAccount();

  const [profile, setProfile] = useState<AiAgentProfile | null>(null);
  const [config, setConfig] = useState<AiChannelConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  const gateOn = subAccount?.emailAiDraftsEnabledByAgency === true;
  const mailboxOn =
    subAccount?.mailboxConfig?.enabled === true &&
    !!subAccount.mailboxConfig.verifiedAt;

  const hydrate = useCallback(async () => {
    setLoaded(false);
    try {
      const [profileRes, channelRes] = await Promise.all([
        fetch(`/api/sub-accounts/${subAccountId}/ai-agent/profile`),
        fetch(`/api/sub-accounts/${subAccountId}/ai-agent/channels/email`),
      ]);
      const profileData = (await profileRes.json()) as {
        profile: AiAgentProfile | null;
      };
      const channelData = (await channelRes.json()) as {
        config: AiChannelConfig | null;
      };
      setProfile(profileData.profile);
      setConfig(channelData.config);
      if (channelData.config) setEnabled(channelData.config.enabled);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Couldn't load the Email AI config: ${msg}`);
    } finally {
      setLoaded(true);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!isAdmin) return;
    void hydrate();
  }, [isAdmin, hydrate]);

  if (!isAdmin) return null;

  // Until the workspace doc arrives the gate reads as off; showing "locked"
  // then would flash on every load of a workspace that has it on.
  if (loading) {
    return (
      <section className="rounded-2xl border bg-card p-6">
        <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
      </section>
    );
  }

  if (!gateOn) {
    return (
      <section className="rounded-2xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Lock className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Email AI drafts</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Email AI drafts are locked for this sub-account. Your agency
              controls whether they&apos;re available — ask your agency owner
              to enable Email AI drafts from the sub-account&apos;s Manage
              panel.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const profileReady = !!profile?.systemPrompt?.trim();

  async function save(next: boolean) {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/ai-agent/channels/email`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        config?: AiChannelConfig;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      setEnabled(next);
      if (data.config) setConfig(data.config);
      toast.success(
        next
          ? "Email AI on — inbound emails now get a suggested reply for approval."
          : "Email AI off.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Mail className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Email AI drafts</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            When a contact emails your connected mailbox, the AI drafts a
            suggested reply in Conversations using the shared persona.{" "}
            <strong className="text-foreground">
              Draft-only: nothing is ever emailed without a person approving
              it
            </strong>{" "}
            — even conversations set to Auto get a draft, not a send.
          </p>
        </div>
      </header>

      {!loaded ? (
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
      ) : (
        <div className="space-y-4">
          {!mailboxOn && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
              No mailbox is connected yet — the AI drafts replies to emails
              that arrive there. Connect one under{" "}
              <Link
                href={saPath("/dashboard/settings?tab=messaging")}
                className="font-medium underline underline-offset-2"
              >
                Settings → Messaging → Email conversations
              </Link>
              , then come back.
            </p>
          )}
          {!profileReady && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
              Set the shared persona prompt on the Overview tab first — it
              defines the voice every channel (including email drafts) speaks
              in.
            </p>
          )}
          <p className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            Each conversation&apos;s AI controls apply: Auto and Suggest both
            get a draft, Off gets none. A conversation that starts with an
            email begins with its AI off — set it to Suggest to get drafts on
            it. Auto-replies, bounces and mailing-list mail never get a draft.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">
                {enabled ? "Email drafting is ON" : "Email drafting is OFF"}
              </p>
              <p className="text-xs text-muted-foreground">
                Drafts appear on the conversation as a &ldquo;suggested
                reply&rdquo; card — edit, approve &amp; send, or discard.
                {typeof config?.totalTokensUsed === "number" &&
                config.totalTokensUsed > 0
                  ? ` Tokens used so far: ${config.totalTokensUsed.toLocaleString()}.`
                  : ""}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant={enabled ? "outline" : "default"}
              disabled={saving || (!enabled && (!mailboxOn || !profileReady))}
              onClick={() => void save(!enabled)}
            >
              {saving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {enabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
