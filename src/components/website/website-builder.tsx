"use client";

import { useEffect, useId, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { isHexColor } from "@/lib/hex-color";
import { effectiveQuality, siteAddress, type WebsiteDoc } from "@/types/website";
import { NICHE_META, isNicheKey } from "@/lib/website/niches";
import { isTemplateConfig } from "@/lib/website/templates";
import {
  ProvisioningSummary,
  premiumPhaseLabel,
} from "@/components/website/website-premium-sections";
import {
  WebsiteWizard,
  wizardStepTitle,
  wizardStepsFor,
  type WizardStepId,
} from "@/components/website/website-wizard";
import { WebsiteEditHelper } from "@/components/website/website-edit-helper";
import { WebsiteDomainDialog } from "@/components/website/website-domain-dialog";
import { WebsiteSeoPanel } from "@/components/website/website-seo-panel";
import { SaveTemplateDialog } from "@/components/website/website-template-save";

/**
 * One website card in the sub-account's list — a compact status card. All
 * input happens in the stepped <WebsiteWizard/> modal it opens (Start /
 * Continue setup for drafts, Try again for failed builds; a live site is
 * edited through Edit site, never rebuilt). The live `doc`
 * is owned by the parent page's collection subscription and passed down —
 * this component never subscribes to Firestore itself.
 */
export function WebsiteBuilder({
  subAccountId,
  doc,
  gateBlocked,
  autoOpen = false,
  onAutoOpened,
  chatSource = null,
  template = null,
  onTemplatesChanged,
}: {
  subAccountId: string;
  doc: WebsiteDoc;
  /** True when the gitpage subscription is needed — setup + build are hidden. */
  gateBlocked: boolean;
  /** Open the wizard straight away (a freshly added site). */
  autoOpen?: boolean;
  /** Told once the auto-open has happened, so the parent can clear it. */
  onAutoOpened?: () => void;
  /** Set when the shared chat bot's knowledge comes from THIS site. */
  chatSource?: { accent: string | null } | null;
  /**
   * Agency templates are switched on for the agency (gitpage): null = off.
   * name = this site's template name when it already is one.
   */
  template?: { name: string | null; scope?: "agency" | "client" | null; asOwner?: boolean; clientTemplates?: boolean } | null;
  /** Reload the agency's templates after a save / remove. */
  onTemplatesChanged?: () => void;
}) {
  const siteId = doc.id;
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [domainOpen, setDomainOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [wizardStart, setWizardStart] = useState<WizardStepId | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [urlShown, setUrlShown] = useState(false);

  useEffect(() => {
    if (autoOpen && !gateBlocked) {
      setWizardStart("start");
      setWizardOpen(true);
      onAutoOpened?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new callback identity is not a new request to open
  }, [autoOpen, gateBlocked]);

  const status = doc.status;
  const isInFlight = status === "queued" || status === "building";
  const docIsPremium = (doc.quality ?? effectiveQuality(doc.config)) === "premium";
  const phaseLabel = premiumPhaseLabel(doc.statusPhase);
  const fromTemplate = isTemplateConfig(doc.config);
  const buildingCopy = fromTemplate
    ? `Building from your template… (1–3 min)${phaseLabel ? ` · ${phaseLabel}` : ""}`
    : docIsPremium
    ? `Building your premium site… (10–20 min)${phaseLabel ? ` · ${phaseLabel}` : ""}`
    : "Building your site… (1–3 min)";
  // The wizard builds every site as premium, so count its steps that way.
  const steps = wizardStepsFor({ ...doc.config, quality: "premium" });
  const savedStep = doc.wizardStep && steps.includes(doc.wizardStep as WizardStepId) ? doc.wizardStep : null;
  const startedSetup = !!savedStep;
  const title = doc.config.heading?.trim() || doc.name || "Untitled site";
  // The address visitors use — the custom domain when one is set.
  const liveUrl = httpsOnly(siteAddress(doc));
  const nicheLabel = isNicheKey(doc.config.niche) ? NICHE_META[doc.config.niche].label : null;
  const kindLabel = (fromTemplate
    ? ["Agency template", doc.config.template_name ? `· ${doc.config.template_name}` : null]
    : [
        docIsPremium ? "Premium" : "Standard",
        doc.config.build_type === "vsl" ? "VSL funnel" : "site",
        nicheLabel ? `· ${nicheLabel}` : null,
      ])
    .filter(Boolean)
    .join(" ");

  function openWizard(at: WizardStepId | null) {
    setWizardStart(at);
    setWizardOpen(true);
  }

  async function handleRecheck() {
    setRechecking(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/website/${siteId}/poll-now`, { method: "POST" });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        settled?: "ready" | "failed" | "client-error";
        deferred?: "in-flight";
        rescheduled?: boolean;
        ignored?: string;
      };
      if (!res.ok) throw new Error(payload.error ?? "Could not re-check.");
      if (payload.settled === "ready") toast.success("Build is live — URL updated.");
      else if (payload.settled === "failed") toast.error("Build failed on gitpage's side.");
      else if (payload.settled === "client-error") toast.error("gitpage rejected the poll — check the error.");
      else if (payload.deferred === "in-flight" && payload.rescheduled) toast.success("Still building — restarted the poll loop.");
      else if (payload.deferred === "in-flight") toast.success("Still building — status refreshed.");
      else toast.info("Nothing to re-check — this site isn't building.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not re-check.");
    } finally {
      setRechecking(false);
    }
  }

  async function handleRemove() {
    if (
      !confirm(
        "Remove this website? This frees a slot so you can build a different one. An already-published site is hidden in gitpage but stays live until its repo is deleted there.",
      )
    )
      return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/website/${siteId}`, { method: "DELETE" });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Could not remove.");
      toast.success("Website removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove.");
    } finally {
      setRemoving(false);
    }
  }

  const accentClass =
    status === "ready"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : status === "failed"
        ? "border-rose-500/30 bg-rose-500/5"
        : isInFlight
          ? "border-amber-500/30 bg-amber-500/5"
          : "bg-card";

  return (
    <div className={`rounded-2xl border ${accentClass}`}>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{title}</p>
            {chatSource && <ChatSourceBadge accent={chatSource.accent} />}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{kindLabel}</p>

          {status === "draft" && (
            <p className="mt-1 text-xs text-muted-foreground">
              {startedSetup
                ? `Draft — saved at step ${steps.indexOf(savedStep as WizardStepId) + 1} of ${steps.length}: ${wizardStepTitle(savedStep)}`
                : "Draft — not set up yet"}
            </p>
          )}
          {isInFlight && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {status === "queued" ? "Build queued — gitpage is starting up…" : buildingCopy}
            </p>
          )}
          {status === "ready" && liveUrl && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {doc.customDomain ? (
                <a href={liveUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate text-primary hover:underline">
                  {doc.customDomain}
                </a>
              ) : urlShown ? (
                <>
                  <a href={liveUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate text-primary hover:underline">
                    {liveUrl}
                  </a>
                  <button type="button" onClick={() => setUrlShown(false)} className="shrink-0 text-muted-foreground hover:text-foreground">
                    Hide
                  </button>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">Live</span>
                  <button type="button" onClick={() => setUrlShown(true)} className="shrink-0 text-primary hover:underline">
                    Show URL
                  </button>
                </>
              )}
              <span className="text-muted-foreground/50">·</span>
              <button type="button" onClick={() => setDomainOpen(true)} className="shrink-0 text-primary hover:underline">
                {doc.customDomain ? "Domain settings" : "Add custom domain"}
              </button>
            </div>
          )}
          {status === "ready" && !liveUrl && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span>
                Marked live, but this site has no usable https address to link to. Build it again with Try again, or
                remove it.
              </span>
            </p>
          )}
          {status === "failed" && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-rose-700 dark:text-rose-400">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span className="line-clamp-2">{doc.errorMessage ?? "gitpage didn't return a live URL."}</span>
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {(isInFlight || (status === "failed" && !!doc.gitpageJobId)) && (
            <Button type="button" size="sm" variant="outline" onClick={handleRecheck} disabled={rechecking}>
              {rechecking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              {rechecking ? "Checking…" : "Re-check now"}
            </Button>
          )}
          {status === "ready" && liveUrl && (
            <Button type="button" size="sm" render={<a href={liveUrl} target="_blank" rel="noreferrer" />}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              Visit
            </Button>
          )}
          {!gateBlocked && status === "draft" && (
            <Button type="button" size="sm" onClick={() => openWizard(null)}>
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              {startedSetup ? "Continue setup" : "Start setup"}
            </Button>
          )}
          {status === "ready" && liveUrl && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1 h-3.5 w-3.5" />
              Edit site
            </Button>
          )}
          {template && status === "ready" && liveUrl && doc.gitpagePageId && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setTemplateOpen(true)}
              title={template.name ? `${template.scope === "client" ? "Template for this client" : "Agency template"}: ${template.name}` : template.asOwner ? "Build new client sites from this one" : "Build new sites for this client from this one"}
              className={template.name ? "border-violet-500/50 text-violet-700 dark:text-violet-300" : undefined}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              {template.name ? "Template" : "Save as template"}
            </Button>
          )}
          {/* No Rebuild on live sites (edit them in Claude, or delete and build
              a new one). A FAILED build published nothing, so retrying it from
              the saved answers is safe — as is a "ready" site with no usable
              address, which nobody can be sent to. */}
          {!gateBlocked && (status === "failed" || (status === "ready" && !liveUrl)) && (
            <Button type="button" size="sm" variant="outline" onClick={() => openWizard("review")}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Try again
            </Button>
          )}
          {!isInFlight && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleRemove}
              disabled={removing}
              aria-label="Remove website"
              title="Remove website"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {doc.partialErrors && doc.partialErrors.length > 0 && (
        <div className="border-t border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Some pages had issues during generation:</p>
          <ul className="mt-1 list-disc pl-5 text-[11px] text-amber-700/90 dark:text-amber-400/90">
            {doc.partialErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {status === "ready" && doc.provisioning && (
        <ProvisioningSummary provisioning={doc.provisioning} subAccountId={subAccountId} />
      )}

      {status === "ready" && liveUrl && <WebsiteSeoPanel />}

      {template && doc.gitpagePageId && (
        <SaveTemplateDialog
          open={templateOpen}
          onOpenChange={setTemplateOpen}
          subAccountId={subAccountId}
          siteId={siteId}
          defaultName={template.name || doc.name || doc.config.heading || ""}
          isTemplate={!!template.name}
          scope={template.scope ?? null}
          asOwner={template.asOwner === true}
          canChooseClient={template.clientTemplates === true}
          onChanged={() => onTemplatesChanged?.()}
        />
      )}

      {status === "ready" && liveUrl && (
        <WebsiteDomainDialog open={domainOpen} onOpenChange={setDomainOpen} subAccountId={subAccountId} doc={doc} />
      )}

      {status === "ready" && liveUrl && (
        <WebsiteEditHelper open={editOpen} onOpenChange={setEditOpen} subAccountId={subAccountId} doc={doc} />
      )}

      {!gateBlocked && (
        <WebsiteWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          subAccountId={subAccountId}
          doc={doc}
          startAt={wizardStart}
        />
      )}
    </div>
  );
}

/**
 * HARDENING: the address comes from gitpage or from the tenant's custom
 * domain; only an https URL may become an href.
 */
function httpsOnly(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Marks the site the sub-account's single chat bot learned from. Hover, or
 * a click / tap / Enter (touch has no hover), explains what that means and
 * how to switch it; a second click, Escape or leaving the badge hides it.
 * The explanation is the badge's description for screen readers either way.
 */
function ChatSourceBadge({ accent }: { accent: string | null }) {
  const tipId = useId();
  const [shown, setShown] = useState(false);
  // HARDENING: a stored colour reaches a style attribute only as #RRGGBB
  // (the alpha suffixes below need the six-digit form).
  const color = isHexColor(accent) ? accent : "#7c3aed";
  return (
    <span className="group relative inline-flex shrink-0">
      <button
        type="button"
        aria-label="Chat bot source"
        aria-describedby={tipId}
        onClick={() => setShown((v) => !v)}
        onBlur={() => setShown(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setShown(false);
        }}
        className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
        style={{ borderColor: `${color}66`, backgroundColor: `${color}1a`, color }}
      >
        <Bot className="h-3 w-3" />
        Chat bot
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={`pointer-events-none absolute left-0 top-full z-20 mt-1.5 w-72 max-w-[80vw] rounded-lg border bg-popover p-3 text-[11px] leading-relaxed text-popover-foreground shadow-lg transition-opacity group-hover:opacity-100 ${
          shown ? "opacity-100" : "opacity-0"
        }`}
      >
        <span className="mb-1 flex items-center gap-1.5 font-medium">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
          The chat bot is based on this site
        </span>
        This workspace has one chat bot, shown on all of its websites. It answers from this site&apos;s content, and its
        bubble colour and greeting come from this site&apos;s design. Publishing another site moves it to that site; &ldquo;Update
        chat bot&rdquo; in a site&apos;s Edit window re-reads that site&apos;s pages. Anything you&apos;ve edited yourself in AI Agents
        stays as you set it.
      </span>
    </span>
  );
}
