"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Lock, MessageCircle } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageLinksTab } from "./message-links-tab";
import { ProfileTab } from "./profile-tab";
import { SenderHeader } from "./sender-header";
import { RATING_LABEL, errorOf, type WaStatusResponse } from "./types";

/**
 * Settings → WhatsApp (SP15): the connected Cloud number's header, profile,
 * message links and a pointer to templates. Every state renders a stable
 * `data-testid` so the E2E suite can assert which one it is looking at.
 * Gate and connection come from the live sub-account doc; everything else
 * from the settings routes (Meta is the source of truth — nothing is cached).
 */

type State =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: WaStatusResponse };

function Card({ testId, icon, children }: { testId: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex items-start gap-3 rounded-2xl border bg-card p-6" data-testid={testId}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{icon}</span>
      <div className="text-sm">{children}</div>
    </section>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "recently";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "recently" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function WhatsappSettings() {
  const { subAccountId, subAccount, loading, isAdmin } = useSubAccount();
  const [state, setState] = useState<State>({ kind: "loading" });
  const gateOn = subAccount?.whatsappEnabledByAgency === true;
  const connected = !!subAccount?.whatsappCloudMeta?.phoneNumberId;

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const res = await fetch(`/api/sub-accounts/${subAccountId}/whatsapp/status`).catch(() => null);
    if (res?.status === 409) return setState({ kind: "empty" });
    if (!res?.ok) return setState({ kind: "error", message: await errorOf(res, "Couldn't reach Meta. Try again.") });
    setState({ kind: "ready", status: (await res.json()) as WaStatusResponse });
  }, [subAccountId]);

  useEffect(() => {
    if (!loading && gateOn && connected) void load();
  }, [loading, gateOn, connected, load]);

  const heading = (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">WhatsApp</h1>
      <p className="text-sm text-muted-foreground">
        The business profile, quality rating and message links of this workspace&apos;s WhatsApp Cloud number.
      </p>
      {!loading && subAccount && !isAdmin && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="wa-settings-view-only">
          View only — ask a workspace admin to edit.
        </p>
      )}
    </div>
  );

  if (loading || !subAccount) {
    return <div className="space-y-6">{heading}<div className="h-40 animate-pulse rounded-2xl border bg-muted/30" data-testid="wa-settings-loading" /></div>;
  }
  if (!gateOn) {
    return (
      <div className="space-y-6">{heading}
        <Card testId="wa-settings-locked" icon={<Lock className="h-4 w-4" />}>
          WhatsApp isn&apos;t enabled for this workspace. Ask your agency to turn it on.
        </Card>
      </div>
    );
  }
  if (!connected || state.kind === "empty") {
    return (
      <div className="space-y-6">{heading}
        <Card testId="wa-settings-empty" icon={<MessageCircle className="h-4 w-4" />}>
          <p>No WhatsApp Cloud number is connected.</p>
          <Link href={`/sa/${subAccountId}/dashboard/settings`} className="text-primary underline">
            Connect one under Settings → Messaging
          </Link>
        </Card>
      </div>
    );
  }
  if (state.kind === "loading") {
    return <div className="space-y-6">{heading}<div className="h-40 animate-pulse rounded-2xl border bg-muted/30" data-testid="wa-settings-loading" /></div>;
  }
  if (state.kind === "error") {
    return (
      <div className="space-y-6">{heading}
        <Card testId="wa-settings-error" icon={<AlertTriangle className="h-4 w-4" />}>
          <p className="text-rose-600 dark:text-rose-400">{state.message}</p>
          <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void load()}>Retry</Button>
        </Card>
      </div>
    );
  }

  const { status } = state;
  return (
    <div className="space-y-6">
      {heading}
      {status.openAlert && (
        <div
          className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300"
          data-testid="wa-quality-alert-banner"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Quality dropped from {RATING_LABEL[status.openAlert.from]} to {RATING_LABEL[status.openAlert.to]} on{" "}
            {fmtDate(status.openAlert.createdAt)}. Meta lowers messaging limits for low-quality numbers — review recent template sends.
          </p>
        </div>
      )}
      <SenderHeader phone={status.phone} />
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile" data-testid="wa-tab-profile">Profile</TabsTrigger>
          <TabsTrigger value="links" data-testid="wa-tab-links">Message Links</TabsTrigger>
          <TabsTrigger value="templates" data-testid="wa-tab-templates">Templates</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="mt-6">
          <ProfileTab subAccountId={subAccountId} phone={status.phone} isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent value="links" className="mt-6">
          <MessageLinksTab subAccountId={subAccountId} isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent value="templates" className="mt-6">
          <section className="rounded-2xl border bg-card p-6 text-sm">
            <p className="font-medium">Message templates</p>
            <p className="mt-1 text-muted-foreground">
              Templates are approved by Meta per WhatsApp Business Account and are managed with the rest of the WhatsApp agent.
            </p>
            <Button className="mt-4" variant="outline" size="sm" render={<Link href={`/sa/${subAccountId}/ai-agents/whatsapp/templates`} data-testid="wa-templates-link" />}>
              Open templates
            </Button>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
