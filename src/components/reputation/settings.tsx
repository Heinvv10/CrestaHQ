"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Lock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { SubAccountGoogleReviewSection } from "@/components/settings/sub-account-google-review-section";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AUTO_REPLY_UI_ENABLED, AutoReplyCard } from "@/components/reputation/auto-reply-card";

/**
 * Reputation → Settings (SP5 c; ledger S1, R6): the "Reviews AI" card — the
 * reply guidelines "Draft with AI" follows — and the existing review-request
 * section, mounted as it is. Connecting Google and choosing the listing stay
 * on AI Agents → Google Business. There is no auto-reply setting: replies
 * are only ever posted by the admin's click.
 */

const MAX = 1000;
type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; enabled: boolean; configured: boolean; draftDailyCap: number; dailyCap: number };

function Loading({ testId }: { testId: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={testId}>
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </p>
  );
}

function ReviewsAiCard({ subAccountId, isAdmin }: { subAccountId: string; isAdmin: boolean }) {
  const api = `/api/sub-accounts/${subAccountId}/reputation/ai-settings`;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const res = await fetch(api, { signal: controller.signal }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as
        | { enabled?: boolean; configured?: boolean; replyGuidelines?: string; draftDailyCap?: number; dailyCap?: number }
        | null;
      if (controller.signal.aborted) return;
      if (!res?.ok || !data || typeof data.enabled !== "boolean") return setLoad({ state: "error" });
      setText(data.replyGuidelines ?? "");
      setLoad({
        state: "ready", enabled: data.enabled, configured: data.configured === true,
        draftDailyCap: Number(data.draftDailyCap), dailyCap: Number(data.dailyCap),
      });
    })();
    return () => controller.abort();
  }, [api]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    const res = await fetch(api, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ replyGuidelines: text }) }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { error?: string; reviewsAiConfig?: { replyGuidelines: string } } | null;
    setSaving(false);
    if (res?.ok && data?.reviewsAiConfig) {
      setText(data.reviewsAiConfig.replyGuidelines);
      setSaved(true);
    } else {
      setError(data?.error ?? "The guidelines could not be saved. Please try again.");
    }
  };

  return (
    <section className="rounded-2xl border bg-card p-6" data-testid="rep-settings-ai-card">
      <h2 className="text-base font-semibold">Reviews AI</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Reply guidelines steer <strong>Draft with AI</strong> in the reply box: tone, how to sign off, things never to say. A draft only
        fills the box — you edit it. Nothing is posted to Google until you click Post reply to Google. There is no auto-reply.
      </p>

      {load.state === "loading" && <Loading testId="rep-settings-ai-loading" />}
      {load.state === "error" && (
        <p className="mt-3 text-sm text-destructive" data-testid="rep-settings-ai-error">The Reviews AI settings could not be loaded.</p>
      )}
      {load.state === "ready" && !load.enabled && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" data-testid="rep-settings-ai-gate-off">
          <Lock className="h-4 w-4" /> Reviews AI is not enabled for this sub-account.
        </p>
      )}
      {load.state === "ready" && load.enabled && (
        <div className="mt-3 space-y-2">
          {!load.configured && (
            <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="rep-settings-ai-not-configured">
              AI drafting isn&apos;t configured on this deployment, so Draft with AI is unavailable. Guidelines can still be saved.
            </p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="rep-settings-ai-limits">
            {`Drafts can use up to ${load.draftDailyCap} of this sub-account's ${load.dailyCap} AI calls a day; the rest stays for sentiment.`}
          </p>
          <label htmlFor="rep-settings-guidelines" className="text-sm font-medium">Reply guidelines</label>
          <p className="text-xs text-muted-foreground" data-testid="rep-settings-guidelines-contacts">
            Contacts written here (phone numbers, emails, links, handles) may appear in drafts — even inside &quot;never mention …&quot;.
          </p>
          <Textarea
            id="rep-settings-guidelines"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            readOnly={!isAdmin}
            maxLength={MAX}
            rows={5}
            placeholder="e.g. Warm and brief. Thank the reviewer by name. Sign off as The Team. Never mention prices."
            data-testid="rep-settings-guidelines"
          />
          <p className="text-xs text-muted-foreground" data-testid="rep-settings-guidelines-count">{`${text.length} / ${MAX}`}</p>
          {error && <p className="text-xs text-destructive" role="alert" data-testid="rep-settings-guidelines-error">{error}</p>}
          {saved && <p className="text-xs text-emerald-700 dark:text-emerald-400" role="status" data-testid="rep-settings-guidelines-saved">Saved.</p>}
          {isAdmin ? (
            <Button type="button" size="sm" onClick={save} disabled={saving} data-testid="rep-settings-guidelines-save">
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Save guidelines
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="rep-settings-guidelines-readonly">Only a sub-account admin can change the guidelines.</p>
          )}
        </div>
      )}
    </section>
  );
}

export function ReputationSettings() {
  const { subAccountId, subAccount, isAdmin, loading } = useSubAccount();
  if (loading || !subAccount) return <Loading testId="rep-settings-loading" />;
  return (
    <div className="space-y-6">
      <ReviewsAiCard subAccountId={subAccountId} isAdmin={isAdmin} />
      {AUTO_REPLY_UI_ENABLED && <AutoReplyCard subAccountId={subAccountId} isAdmin={isAdmin} />}
      <SubAccountGoogleReviewSection />
      <p className="text-sm text-muted-foreground">
        Connect Google Business Profile and choose the listing in{" "}
        <Link href={`/sa/${subAccountId}/ai-agents/google-business`} className="font-medium text-foreground underline-offset-2 hover:underline" data-testid="rep-settings-google-link">
          AI Agents → Google Business
        </Link>
        .
      </p>
    </div>
  );
}
