"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useOptionalSubAccount } from "@/context/sub-account-context";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  BuildModePicker,
  Field,
  NicheTilePicker,
  PageRow,
  Section,
  Select,
  type BuildMode,
} from "@/components/website/website-form-parts";
import {
  ConceptPicker,
  HeroMotionSelect,
  LeadCaptureToggles,
  PremiumDetailsFields,
} from "@/components/website/website-premium-sections";
import {
  blankBusinessDetails,
  blankServicesConfig,
  blankVslConfig,
  blankWebsiteConfig,
  effectiveQuality,
  sampleVslConfig,
  sampleWebsiteConfig,
  type BuildType,
  type Niche,
  type WebsiteBusinessDetails,
  type WebsiteConfig,
  type WebsiteDoc,
  type WebsiteServicesConfig,
} from "@/types/website";
import type { SubAccountDoc } from "@/types/tenancy";
import { isNicheKey, NICHE_META, nicheSample } from "@/lib/website/niches";
import { isTemplateConfig } from "@/lib/website/templates";
import { TemplatePicker, type WizardTemplate } from "@/components/website/website-template-picker";
import { premiumModeFor } from "@/lib/website/premium";
import {
  validateWebsiteConfig,
  type ValidationErrors,
} from "@/lib/website/validation";
import {
  GITPAGE_COLOR_SCHEMES,
  GITPAGE_DESIGN_BUTTONS,
  GITPAGE_DESIGN_COLOR_PALETTES,
  GITPAGE_DESIGN_COMPONENTS,
  GITPAGE_DESIGN_CONTACT_FORM,
  GITPAGE_DESIGN_ICONS,
  GITPAGE_DESIGN_INTERACTIONS,
  GITPAGE_DESIGN_LAYOUT,
  GITPAGE_DESIGN_TYPOGRAPHY,
  GITPAGE_LANGUAGES,
} from "@/lib/website/gitpage-values";

/**
 * The website build wizard — a modal that walks the operator through the
 * build inputs one logical step at a time (Back / Next, progress dots).
 *
 * Steps are derived from the choices made so far, so each screen only shows
 * what applies: a VSL gets a Video step instead of Pages, the Location step
 * only appears when the site has a contact page, and the optional "Your
 * story" step is premium-only. "Next" validates only the current step; the
 * draft is saved (PATCH …/website/[siteId]) on every Next and on close, so
 * nothing typed is ever lost and reopening resumes on the saved step.
 */

export type WizardStepId =
  | "start"
  | "business"
  | "pages"
  | "video"
  | "location"
  | "look"
  | "story"
  | "review";

const STEP_META: Record<WizardStepId, { title: string; blurb: string }> = {
  start: { title: "Start", blurb: "What are we building, and at what quality?" },
  business: { title: "The business", blurb: "The core message — what the site is and who it's for." },
  pages: { title: "Pages & services", blurb: "Which pages the site includes and what you offer." },
  video: { title: "Video", blurb: "The video at the heart of the funnel." },
  location: { title: "Location & hours", blurb: "Where to find the business and when it's open." },
  look: { title: "Look & feel", blurb: "The design direction, surface and brand colours." },
  story: { title: "Your story", blurb: "Optional facts the copywriter may use verbatim. Nothing is ever invented." },
  review: { title: "Review & build", blurb: "Check the details, choose what gets wired in, then build." },
};

export function wizardStepsFor(config: WebsiteConfig): WizardStepId[] {
  // Agency template: the template supplies design, pages and copy — only the
  // business details are asked (on the Location step).
  if (isTemplateConfig(config)) return ["start", "location", "review"];
  const local = (config.build_type ?? "local") === "local";
  const premium = effectiveQuality(config) === "premium";
  const steps: WizardStepId[] = ["start", "business", local ? "pages" : "video"];
  if (local && config.local_page_selections?.contact) steps.push("location");
  steps.push("look");
  if (premium) steps.push("story");
  steps.push("review");
  return steps;
}

export function wizardStepTitle(step: string | null | undefined): string | null {
  return step && step in STEP_META ? STEP_META[step as WizardStepId].title : null;
}

/** Which step owns a validation error key. Unknown keys land on Review. */
function stepForError(key: string, buildType: BuildType, template = false): WizardStepId {
  if (template) {
    if (key === "template_id") return "start";
    if (key === "contact_details" || key === "cta_link" || key.startsWith("business_details")) return "location";
    return "review";
  }
  if (["heading", "hero_statement", "features", "benefits", "contact_details", "cta_link", "language"].includes(key)) return "business";
  if (key === "quality" || key === "niche") return "start";
  if (key === "video_link") return "video";
  if (key.startsWith("local_page_selections") || key.startsWith("services_config")) return "pages";
  if (key.startsWith("business_details")) return buildType === "local" ? "location" : "review";
  // HARDENING: our validation also checks the concept id (a gitpage slug).
  if (key.startsWith("design_") || key === "custom_colors" || key === "color_scheme" || key === "hero_motion" || key === "concept") return "look";
  if (key.startsWith("premium_details")) return "story";
  return "review";
}

function modeFor(config: WebsiteConfig): BuildMode {
  if (isTemplateConfig(config)) return "template";
  if (isNicheKey(config.niche)) return "niche";
  return config.build_type === "vsl" ? "standard_vsl" : "standard_local";
}

function initialConfig(doc: WebsiteDoc): WebsiteConfig {
  return {
    ...blankWebsiteConfig(),
    ...doc.config,
    quality: "premium",
    build_type: doc.config.build_type ?? "local",
    video_link: doc.config.video_link ?? "",
  };
}

export function websiteVoiceAvailableForBuild(
  sub: Pick<SubAccountDoc, "webVoiceEnabledByAgency" | "webChatEnabledByAgency" | "webVoiceMeta"> | null | undefined,
): boolean {
  return !!sub && sub.webVoiceEnabledByAgency === true && sub.webChatEnabledByAgency !== false && sub.webVoiceMeta?.ready === true;
}

export function WebsiteWizard({
  open,
  onOpenChange,
  subAccountId,
  doc,
  startAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subAccountId: string;
  doc: WebsiteDoc;
  /** Step to open on; defaults to the saved step, else Start. */
  startAt?: WizardStepId | null;
}) {
  const siteId = doc.id;
  const subAccount = useOptionalSubAccount()?.subAccount;
  // A failed site that still carries its job can yet go live from that job,
  // so the PATCH route refuses to change its config (409). Don't send saves
  // the route will refuse; Build (which replaces the job) still works.
  const draftSavable = !(doc.status === "failed" && !!doc.gitpageJobId);
  const [config, setConfig] = useState<WebsiteConfig>(() => initialConfig(doc));
  const [mode, setMode] = useState<BuildMode>(() => modeFor(initialConfig(doc)));
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [step, setStep] = useState<WizardStepId>("start");
  const [maxReached, setMaxReached] = useState(0);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  // The agency's saved templates (gitpage); empty = the option stays hidden.
  const [templates, setTemplates] = useState<WizardTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templatesEnabled, setTemplatesEnabled] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const steps = useMemo(() => wizardStepsFor(config), [config]);
  const stepIndex = Math.max(0, steps.indexOf(step));
  const buildType: BuildType = config.build_type ?? "local";
  const niche: Niche | null = isNicheKey(config.niche) ? config.niche : null;
  const isTemplate = isTemplateConfig(config);
  // Premium only (Ben, 2026-10-01) — Standard is no longer offered.
  const quality = "premium" as const;
  const isPremium = true;

  // Re-seed from the server doc each time the modal opens.
  useEffect(() => {
    if (!open) return;
    const fresh = initialConfig(doc);
    setConfig(fresh);
    setMode(modeFor(fresh));
    setErrors({});
    const freshSteps = wizardStepsFor(fresh);
    const wanted = (startAt ?? (doc.wizardStep as WizardStepId | null) ?? "start") as WizardStepId;
    const target = freshSteps.includes(wanted) ? wanted : "start";
    setStep(target);
    // A resumed draft has already been through every step before the saved one.
    setMaxReached(freshSteps.indexOf(target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Load the agency's templates when the modal opens (never blocks the wizard).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTemplatesLoaded(false);
    fetch(`/api/sub-accounts/${subAccountId}/website/templates`)
      .then((r) => (r.ok ? r.json() : { enabled: false, templates: [] }))
      .then((body: { enabled?: boolean; templates?: WizardTemplate[] }) => {
        if (cancelled) return;
        const list = Array.isArray(body.templates) ? body.templates : [];
        setTemplates(list);
        setTemplatesEnabled(body.enabled === true || list.length > 0);
      })
      .catch(() => {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, subAccountId]);

  // If a choice removes the current step (e.g. contact page unticked), fall back.
  useEffect(() => {
    if (!steps.includes(step)) setStep(steps[Math.min(stepIndex, steps.length - 1)]);
  }, [steps, step, stepIndex]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [step]);

  // ---- config mutators (same rules as the old long form) -------------------

  function update<K extends keyof WebsiteConfig>(key: K, value: WebsiteConfig[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function switchMode(next: BuildMode) {
    if (next === mode) return;
    setMode(next);
    setErrors({});
    if (next === "standard_local") setConfig({ ...blankWebsiteConfig(), quality });
    else if (next === "standard_vsl") setConfig({ ...blankVslConfig(), quality });
    else setConfig({ ...blankWebsiteConfig(), niche: null, quality });
  }

  function selectTemplate(t: WizardTemplate) {
    // Keep business details already typed when switching between templates.
    setConfig((prev) => ({
      ...blankWebsiteConfig(),
      quality,
      template_id: t.templateId,
      template_name: t.name,
      contact_details: isTemplateConfig(prev) ? prev.contact_details : "",
      local_page_selections: { index: true, services: false, contact: true, privacy: false, terms: false },
      business_details: (isTemplateConfig(prev) && prev.business_details) || blankBusinessDetails(),
    }));
    setErrors({});
  }

  function selectNiche(key: Niche, asBuildType: BuildType) {
    const meta = NICHE_META[key];
    const base = asBuildType === "vsl" ? blankVslConfig() : blankWebsiteConfig();
    setConfig({
      ...base,
      quality,
      niche: key,
      color_scheme: meta.defaultColorScheme,
      ...(asBuildType === "local"
        ? {
            local_page_selections: { index: true, services: true, contact: true, privacy: true, terms: true },
            services_config: { let_ai_do_services: true, services_list: "" },
            business_details: blankBusinessDetails(),
          }
        : {}),
    });
    setErrors({});
  }

  function togglePage(page: "services" | "contact" | "privacy" | "terms", next: boolean) {
    setConfig((prev) => {
      const updated: WebsiteConfig = {
        ...prev,
        local_page_selections: { ...prev.local_page_selections, [page]: next },
      };
      if (page === "services") updated.services_config = next ? prev.services_config ?? blankServicesConfig() : null;
      if (page === "contact") updated.business_details = next ? prev.business_details ?? blankBusinessDetails() : null;
      return updated;
    });
  }

  function updateServices<K extends keyof WebsiteServicesConfig>(key: K, value: WebsiteServicesConfig[K]) {
    setConfig((prev) =>
      prev.services_config ? { ...prev, services_config: { ...prev.services_config, [key]: value } } : prev,
    );
  }

  function updateBusiness<K extends keyof WebsiteBusinessDetails>(key: K, value: WebsiteBusinessDetails[K]) {
    setConfig((prev) =>
      prev.business_details ? { ...prev, business_details: { ...prev.business_details, [key]: value } } : prev,
    );
  }

  function loadSample() {
    let sample: WebsiteConfig;
    let label: string;
    if (niche) {
      sample = nicheSample(niche, buildType)();
      label = `${NICHE_META[niche].label} ${buildType === "vsl" ? "VSL" : "site"}`;
    } else if (buildType === "vsl") {
      sample = sampleVslConfig();
      label = "coaching VSL";
    } else {
      sample = sampleWebsiteConfig();
      label = "Starbucks Chadstone";
    }
    setConfig({ ...sample, quality: "premium" });
    setErrors({});
    toast.success(`Sample data loaded — ${label}. Step through to review it.`);
  }

  // ---- persistence + navigation ---------------------------------------------

  async function saveDraft(atStep: WizardStepId, cfg: WebsiteConfig = config): Promise<boolean> {
    if (!draftSavable) return false;
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/website/${siteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfg, wizardStep: atStep }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Could not save the draft.");
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the draft.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function errorsForStep(target: WizardStepId): ValidationErrors {
    if (target === "start") {
      if (mode === "template" && !isTemplate) return { template_id: "Pick a template to continue." };
      return mode === "niche" && !niche ? { niche: "Pick a niche template to continue." } : {};
    }
    const all = validateWebsiteConfig(config);
    return Object.fromEntries(
      Object.entries(all).filter(([k]) => stepForError(k, buildType, isTemplate) === target),
    );
  }

  function goTo(index: number) {
    const target = steps[index];
    if (!target) return;
    setStep(target);
    setMaxReached((m) => Math.max(m, index));
  }

  async function next() {
    const stepErrors = errorsForStep(step);
    setErrors(stepErrors);
    const first = Object.values(stepErrors)[0];
    if (first) {
      toast.error(first);
      return;
    }
    const target = steps[stepIndex + 1];
    if (!target) return;
    // Advance only once the step is saved (the refusal is already on
    // screen), so Review's "every step is saved" holds. A draft the route
    // would refuse anyway (see `draftSavable`) moves on unsaved, and Review
    // says so.
    if (draftSavable && !(await saveDraft(target))) return;
    goTo(stepIndex + 1);
  }

  function back() {
    setErrors({});
    goTo(stepIndex - 1);
  }

  function handleOpenChange(nextOpen: boolean) {
    // Save on close too, so even a half-filled step is never lost.
    if (!nextOpen && !building) void saveDraft(step);
    onOpenChange(nextOpen);
  }

  async function build() {
    const all = validateWebsiteConfig(config);
    const startErrors = errorsForStep("start");
    const merged = { ...startErrors, ...all };
    if (Object.keys(merged).length) {
      const firstKey = Object.keys(merged)[0];
      const target = startErrors.niche || startErrors.template_id ? "start" : stepForError(firstKey, buildType, isTemplate);
      setErrors(merged);
      if (steps.includes(target)) setStep(target);
      toast.error(merged[firstKey]);
      return;
    }
    setBuilding(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/website/${siteId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; fieldErrors?: ValidationErrors };
      if (!res.ok) {
        if (payload.fieldErrors) {
          setErrors(payload.fieldErrors);
          const k = Object.keys(payload.fieldErrors)[0];
          const target = k ? stepForError(k, buildType, isTemplate) : null;
          if (target && steps.includes(target)) setStep(target);
        }
        throw new Error(payload.error ?? "Could not start build.");
      }
      toast.success(
        isTemplate
          ? "Template build started — usually 1–3 minutes. You can leave this page."
          : isPremium
          ? "Premium build started — usually 10–20 minutes. You can leave this page."
          : "Build started — usually 1–3 minutes.",
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start build.");
    } finally {
      setBuilding(false);
    }
  }

  const isLast = stepIndex === steps.length - 1;
  const storyFilled = !!config.premium_details && Object.values(config.premium_details).some((v) => typeof v === "string" && v.trim());
  const meta = STEP_META[step];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(760px,92vh)] w-full flex-col gap-0 p-0 sm:max-w-3xl">
        <div className="relative border-b bg-gradient-to-r from-violet-500/10 via-indigo-500/5 to-transparent px-6 pb-4 pt-5">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 rounded-t-xl bg-gradient-to-r from-violet-500 via-indigo-500 to-transparent" />
          <p className="text-[11px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300">
            Step {stepIndex + 1} of {steps.length}
          </p>
          <DialogTitle className="mt-1 text-base font-semibold">{meta.title}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">{meta.blurb}</DialogDescription>
        </div>

        <div ref={bodyRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {step === "start" && (
            <>
              <Section title="Site type" description="Pick the kind of site — switching clears what you've entered.">
                <BuildModePicker
                  value={mode}
                  onChange={switchMode}
                  disabled={building}
                  showTemplate={templatesEnabled || mode === "template"}
                />
              </Section>
              {mode === "template" && (
                <Section title="Pick a template" description="Your agency's saved sites. The new site copies its design and pages, with this business's details.">
                  {templatesLoaded ? (
                    <TemplatePicker templates={templates} value={config.template_id} onPick={selectTemplate} disabled={building} />
                  ) : (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your templates…</p>
                  )}
                  {templatesLoaded && isTemplate && !templates.some((t) => t.templateId === config.template_id) && (
                    <p className="mt-2 text-[11px] text-muted-foreground">Selected: {config.template_name || "a saved template"}</p>
                  )}
                  {errors.template_id && <p className="mt-2 text-[11px] text-destructive">{errors.template_id}</p>}
                </Section>
              )}
              {mode === "niche" && !niche && (
                <Section title="Pick your niche" description="Each niche ships a researched section structure and copy tone.">
                  <NicheTilePicker onPick={selectNiche} disabled={building} />
                  {errors.niche && <p className="mt-2 text-[11px] text-destructive">{errors.niche}</p>}
                </Section>
              )}
              {mode === "niche" && niche && (
                <Section title="Niche template" description="Locked to this niche. Change it to pick another.">
                  <div className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl leading-none">{NICHE_META[niche].emoji}</span>
                      <div>
                        <p className="text-sm font-medium">
                          {NICHE_META[niche].label} · {buildType === "vsl" ? "VSL funnel" : "Site"}
                        </p>
                        <p className="text-[11px] text-muted-foreground">{NICHE_META[niche].description}</p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setConfig({ ...blankWebsiteConfig(), niche: null, quality });
                        setErrors({});
                      }}
                    >
                      Change
                    </Button>
                  </div>
                </Section>
              )}
              <div className="flex items-start gap-3 rounded-xl border border-violet-500/20 bg-gradient-to-r from-violet-500/10 via-indigo-500/5 to-transparent p-4">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
                <p className="text-xs text-muted-foreground">
                  {mode === "template" ? (
                    <>
                      <span className="font-medium text-foreground">Built from your template:</span> same design, pages and
                      photography, with this business&apos;s name, contact details and address, and this workspace&apos;s contact
                      form + AI chat. Builds take 1–3 minutes.
                    </>
                  ) : (
                    <>
                  <span className="font-medium text-foreground">Every site is a premium build:</span> a studio-grade design,
                  copy written by the strongest model, generated photography, and your contact form + AI chat wired in.
                  Builds take 10–20 minutes.
                    </>
                  )}
                </p>
              </div>
              {(mode !== "niche" || niche) && mode !== "template" && (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-violet-500/30 bg-violet-500/[0.03] p-4">
                  <p className="text-xs text-muted-foreground">
                    Just exploring? Fill every step with realistic sample data for this site type.
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={loadSample}>
                    Load sample data
                  </Button>
                </div>
              )}
            </>
          )}

          {step === "business" && (
            <div className="grid gap-4">
              <Field label="Heading" hint="Max 80 characters." error={errors.heading}>
                <Input
                  value={config.heading}
                  onChange={(e) => update("heading", e.target.value)}
                  maxLength={80}
                  placeholder={buildType === "vsl" ? "Scale Your Coaching To $30k/Month" : "Acme Plumbing"}
                />
              </Field>
              <Field label="Hero statement" hint="One line under the heading. Max 80 characters." error={errors.hero_statement}>
                <Textarea
                  rows={2}
                  value={config.hero_statement}
                  onChange={(e) => update("hero_statement", e.target.value)}
                  maxLength={80}
                  placeholder="24-hour emergency plumbing in Sydney"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Features" hint="3 short items, comma-separated. Max 60 characters." error={errors.features}>
                  <Input
                    value={config.features}
                    onChange={(e) => update("features", e.target.value)}
                    maxLength={60}
                    placeholder="24/7 response, Licensed, Fixed-fee"
                  />
                </Field>
                <Field label="Benefits" hint="3 short items, comma-separated. Max 60 characters." error={errors.benefits}>
                  <Input
                    value={config.benefits}
                    onChange={(e) => update("benefits", e.target.value)}
                    maxLength={60}
                    placeholder="No surprises, Fast service, Guaranteed"
                  />
                </Field>
                <Field label="Contact email" error={errors.contact_details}>
                  <Input
                    type="email"
                    value={config.contact_details}
                    onChange={(e) => update("contact_details", e.target.value)}
                    placeholder="hello@acme.com"
                  />
                </Field>
                <Field label="Main button link" hint="Where the site's call-to-action goes." error={errors.cta_link}>
                  <Input
                    type="url"
                    value={config.cta_link}
                    onChange={(e) => update("cta_link", e.target.value)}
                    placeholder="https://book.acme.com"
                  />
                </Field>
                <Field label="Language" error={errors.language}>
                  <Select value={config.language} onChange={(v) => update("language", v)} options={GITPAGE_LANGUAGES} />
                </Field>
              </div>
            </div>
          )}

          {step === "video" && (
            <>
              <Field
                label="Video link"
                hint="YouTube / Vimeo / Wistia EMBED URL, e.g. https://www.youtube.com/embed/dQw4w9WgXcQ"
                error={errors.video_link}
              >
                <Input
                  type="url"
                  value={config.video_link}
                  onChange={(e) => update("video_link", e.target.value)}
                  placeholder="https://www.youtube.com/embed/..."
                />
              </Field>
            </>
          )}

          {step === "pages" && (
            <>
              {niche ? (
                <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                  {NICHE_META[niche].label} sites always include Home, Services, Contact, Privacy and Terms.
                </p>
              ) : (
                <Section title="Pages" description="Which pages should the site include?">
                  <div className="space-y-2">
                    <PageRow formId={siteId} id="index" label="Home (index.html)" hint="Required" disabled checked />
                    <PageRow formId={siteId} id="services" label="Services" checked={config.local_page_selections.services} onChange={(v) => togglePage("services", v)} />
                    <PageRow formId={siteId} id="contact" label="Contact" hint="Adds the Location & hours step." checked={config.local_page_selections.contact} onChange={(v) => togglePage("contact", v)} />
                    <PageRow formId={siteId} id="privacy" label="Privacy policy" checked={config.local_page_selections.privacy} onChange={(v) => togglePage("privacy", v)} />
                    <PageRow formId={siteId} id="terms" label="Terms" checked={config.local_page_selections.terms} onChange={(v) => togglePage("terms", v)} />
                  </div>
                  {errors["local_page_selections.index"] && (
                    <p className="mt-2 text-[11px] text-destructive">{errors["local_page_selections.index"]}</p>
                  )}
                </Section>
              )}
              {config.local_page_selections.services && config.services_config && (
                <Section
                  title="Services"
                  description={
                    niche
                      ? `Leave this on to use the ${NICHE_META[niche].label} default services, or untick to list your own.`
                      : "Used to populate the services page."
                  }
                >
                  <div className="space-y-4">
                    <label className="flex items-center gap-3 rounded-lg border bg-background p-3">
                      <Checkbox
                        checked={config.services_config.let_ai_do_services}
                        onCheckedChange={(c) => updateServices("let_ai_do_services", c === true)}
                      />
                      <div>
                        <p className="text-sm font-medium">
                          {niche ? "Use the niche's default services" : "Let AI write the services list"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {niche
                            ? "Your own list always wins when you provide one."
                            : "Written from your features and benefits."}
                        </p>
                      </div>
                    </label>
                    {!config.services_config.let_ai_do_services && (
                      <Field
                        label="Services list"
                        hint="One per line or semicolon-separated, e.g. “Emergency repairs — burst pipes, 24/7”."
                        error={errors["services_config.services_list"] ?? errors.services_config}
                      >
                        <Textarea
                          rows={4}
                          value={config.services_config.services_list}
                          onChange={(e) => updateServices("services_list", e.target.value)}
                        />
                      </Field>
                    )}
                  </div>
                </Section>
              )}
            </>
          )}

          {step === "location" && config.business_details && (
            <div className="grid gap-3 sm:grid-cols-2">
              {isTemplate && (
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  These replace the template business&apos;s name, contact details, address and main button everywhere on the
                  site. Fill in the phone and address if the template shows them. Opening hours, team and testimonials are
                  copied from the template — edit them in the site editor afterwards.
                </p>
              )}
              {isTemplate && (
                <Field label="Contact email" hint="Shown on the site and used for enquiries." error={errors.contact_details}>
                  <Input type="email" value={config.contact_details} onChange={(e) => update("contact_details", e.target.value)} placeholder="hello@acme.com" />
                </Field>
              )}
              {isTemplate && (
                <Field label="Main button link" hint="Replaces the template's booking / call-to-action link." error={errors.cta_link}>
                  <Input type="url" value={config.cta_link} onChange={(e) => update("cta_link", e.target.value)} placeholder="https://book.acme.com" />
                </Field>
              )}
              <Field label="Business name" error={errors["business_details.business_name"]}>
                <Input value={config.business_details.business_name} onChange={(e) => updateBusiness("business_name", e.target.value)} />
              </Field>
              <Field label="Phone" error={errors["business_details.business_phone"]}>
                <Input value={config.business_details.business_phone} onChange={(e) => updateBusiness("business_phone", e.target.value)} />
              </Field>
              <Field label="Street" error={errors["business_details.business_street"]}>
                <Input value={config.business_details.business_street} onChange={(e) => updateBusiness("business_street", e.target.value)} />
              </Field>
              <Field label="City" error={errors["business_details.business_city"]}>
                <Input value={config.business_details.business_city} onChange={(e) => updateBusiness("business_city", e.target.value)} />
              </Field>
              <Field label="State / region" error={errors["business_details.business_state"]}>
                <Input value={config.business_details.business_state} onChange={(e) => updateBusiness("business_state", e.target.value)} />
              </Field>
              <Field label="Country" error={errors["business_details.business_country"]}>
                <Input value={config.business_details.business_country} onChange={(e) => updateBusiness("business_country", e.target.value)} />
              </Field>
              <Field label="Postcode / ZIP" error={errors["business_details.business_zip"]}>
                <Input value={config.business_details.business_zip} onChange={(e) => updateBusiness("business_zip", e.target.value)} />
              </Field>
              {!isTemplate && (
                <>
                  <Field label="Business email">
                    <Input type="email" value={config.business_details.business_email} onChange={(e) => updateBusiness("business_email", e.target.value)} />
                  </Field>
                  <Field label="Google rating" hint="e.g. 4.8">
                    <Input value={config.business_details.google_rating} onChange={(e) => updateBusiness("google_rating", e.target.value)} />
                  </Field>
                  <Field label="Google review count" hint="e.g. 127">
                    <Input value={config.business_details.google_review_count} onChange={(e) => updateBusiness("google_review_count", e.target.value)} />
                  </Field>
                </>
              )}
              {/* A template's opening hours are copied as they are (edit them in the site editor). */}
              {!isTemplate && (
              <div className="sm:col-span-2">
                <Field label="Opening hours" hint='Free text, e.g. "Mon–Fri 8–6, Sat 10–2".'>
                  <Textarea rows={2} value={config.business_details.opening_hours} onChange={(e) => updateBusiness("opening_hours", e.target.value)} />
                </Field>
              </div>
              )}
            </div>
          )}

          {step === "look" && (
            <>
              {isPremium && (
                <Section
                  title="Design direction"
                  description="Three studio concepts per niche — each a genuinely different site, not a re-skin. Or let the studio choose."
                >
                  <ConceptPicker
                    subAccountId={subAccountId}
                    niche={niche}
                    mode={premiumModeFor(config)}
                    value={config.concept ?? null}
                    onChange={(id) => update("concept", id)}
                    disabled={building}
                  />
                </Section>
              )}
              <HeroMotionSelect value={config.hero_motion ?? null} onChange={(v) => update("hero_motion", v)} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Colour scheme" hint={isPremium ? "Light or dark surface — the concept adapts." : undefined} error={errors.color_scheme}>
                  <Select
                    value={config.color_scheme}
                    onChange={(v) => update("color_scheme", v as WebsiteConfig["color_scheme"])}
                    options={GITPAGE_COLOR_SCHEMES}
                  />
                </Field>
                <Field
                  label={isPremium ? "Brand colours" : "Colour palette"}
                  hint={isPremium ? "Leave on the default to use the concept's palette; pick Custom for your own." : undefined}
                  error={errors.design_color_palette}
                >
                  <Select
                    value={config.design_color_palette}
                    onChange={(v) => update("design_color_palette", v)}
                    options={GITPAGE_DESIGN_COLOR_PALETTES}
                  />
                </Field>
                {config.design_color_palette === "Custom" && (
                  <Field label="Custom colours" hint='Three hex values, e.g. "#5B4BFF,#EEF0FF,#00E5A8".' error={errors.custom_colors}>
                    <Input
                      value={config.custom_colors}
                      onChange={(e) => update("custom_colors", e.target.value)}
                      placeholder="#5B4BFF,#EEF0FF,#00E5A8"
                    />
                  </Field>
                )}
                {!isPremium && (
                  <>
                    <Field label="Typography">
                      <Select value={config.design_typography} onChange={(v) => update("design_typography", v)} options={GITPAGE_DESIGN_TYPOGRAPHY} />
                    </Field>
                    <Field label="Layout">
                      <Select value={config.design_layout} onChange={(v) => update("design_layout", v)} options={GITPAGE_DESIGN_LAYOUT} />
                    </Field>
                    <Field label="Components">
                      <Select value={config.design_components} onChange={(v) => update("design_components", v)} options={GITPAGE_DESIGN_COMPONENTS} />
                    </Field>
                    <Field label="Interactions">
                      <Select value={config.design_interactions} onChange={(v) => update("design_interactions", v)} options={GITPAGE_DESIGN_INTERACTIONS} />
                    </Field>
                    <Field label="Buttons">
                      <Select value={config.design_buttons} onChange={(v) => update("design_buttons", v)} options={GITPAGE_DESIGN_BUTTONS} />
                    </Field>
                    <Field label="Contact form">
                      <Select value={config.design_contact_form} onChange={(v) => update("design_contact_form", v)} options={GITPAGE_DESIGN_CONTACT_FORM} />
                    </Field>
                    <Field label="Icons">
                      <Select value={config.design_icons} onChange={(v) => update("design_icons", v)} options={GITPAGE_DESIGN_ICONS} />
                    </Field>
                  </>
                )}
              </div>
            </>
          )}

          {step === "story" && (
            <PremiumDetailsFields
              niche={niche}
              value={config.premium_details ?? null}
              errors={errors as Record<string, string>}
              onChange={(nextDetails) => update("premium_details", nextDetails)}
            />
          )}

          {step === "review" && (
            <>
              <ReviewSummary config={config} steps={steps} saved={draftSavable} onEdit={(s) => goTo(steps.indexOf(s))} />
              {isPremium && !isTemplate && (
                <Section title="Wired in on publish" description="On by default — the site feeds this workspace from day one.">
                  <LeadCaptureToggles
                    includeForm={config.include_form !== false}
                    includeChat={config.include_chat !== false}
                    includeVoice={config.include_voice !== false}
                    voiceAvailable={websiteVoiceAvailableForBuild(subAccount)}
                    onChange={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
                  />
                </Section>
              )}
              {!isTemplate && (
              <label className="flex items-center gap-3 rounded-lg border bg-background p-3">
                <Checkbox checked={config.include_faq} onCheckedChange={(c) => update("include_faq", c === true)} />
                <div>
                  <p className="text-sm font-medium">Include an FAQ section</p>
                  <p className="text-xs text-muted-foreground">Questions and answers written from what you&apos;ve told us.</p>
                </div>
              </label>
              )}
              <p className="flex items-center gap-2 rounded-xl border border-violet-500/20 bg-gradient-to-br from-violet-500/10 via-indigo-500/5 to-transparent p-4 text-xs text-muted-foreground">
                <Sparkles className="h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" />
                {isTemplate
                  ? "Template builds take 1–3 minutes — copy, rebrand, publish. This workspace's contact form and AI chat are wired in when the template has them."
                  : isPremium
                  ? "Premium builds take 10–20 minutes — brief, photography, design, publish. You can close this and leave the page; the card shows progress."
                  : "Standard builds take 1–3 minutes."}
              </p>
            </>
          )}
        </div>

        {/* Narrow screens: Back is icon-only, Build site reads "Build" (a
            spinner alone while starting) and the dots' 24px hit areas sit
            edge to edge, so seven steps fit a 360px-wide phone:
            36 + 4 + 7×24 + 4 + ~75 ≈ 287px of the 296px the footer has. */}
        <div className="flex items-center gap-1 border-t px-4 py-4 sm:gap-3 sm:px-6">
          <div className="w-9 shrink-0 sm:w-28">
            {stepIndex > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={back} disabled={building} aria-label="Back">
                <ArrowLeft className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">Back</span>
              </Button>
            )}
          </div>
          <StepDots steps={steps} current={stepIndex} maxReached={maxReached} onJump={goTo} disabled={building} />
          <div className="flex shrink-0 justify-end sm:w-28">
            {isLast ? (
              <Button
                type="button"
                size="sm"
                onClick={build}
                disabled={building || saving}
                aria-label={building ? "Starting…" : "Build site"}
                className="bg-gradient-to-r from-violet-600 to-indigo-600 text-white hover:from-violet-500 hover:to-indigo-500"
              >
                {building ? <Loader2 className="h-4 w-4 animate-spin sm:mr-1" /> : <Sparkles className="mr-1 h-4 w-4" />}
                {building ? (
                  <span className="hidden sm:inline">Starting…</span>
                ) : (
                  <>
                    Build<span className="hidden sm:inline"> site</span>
                  </>
                )}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={next} disabled={saving || building} className="bg-violet-600 text-white hover:bg-violet-500">
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                {step === "story" && !storyFilled ? "Skip" : "Next"} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepDots({
  steps,
  current,
  maxReached,
  onJump,
  disabled,
}: {
  steps: WizardStepId[];
  current: number;
  maxReached: number;
  onJump: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <nav aria-label="Build steps" className="flex min-w-0 flex-1 items-center justify-center gap-0 sm:gap-1">
      {steps.map((s, i) => {
        const reachable = i <= maxReached && !disabled;
        const isCurrent = i === current;
        const done = i < current || (i <= maxReached && !isCurrent);
        // The button is the hit area (at least 24×24px); the bar inside it
        // is only what the step looks like.
        return (
          <button
            key={s}
            type="button"
            onClick={() => reachable && onJump(i)}
            disabled={!reachable}
            aria-current={isCurrent ? "step" : undefined}
            aria-label={`Step ${i + 1}: ${STEP_META[s].title}`}
            title={STEP_META[s].title}
            className={
              "group flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 " +
              (reachable ? "cursor-pointer" : "cursor-default")
            }
          >
            <span
              aria-hidden
              className={
                "block h-1.5 rounded-full transition-all " +
                (isCurrent
                  ? "w-5 bg-gradient-to-r from-violet-500 to-indigo-500 sm:w-8"
                  : done
                    ? "w-2 bg-violet-500/50 group-hover:bg-violet-500/70 sm:w-4"
                    : "w-2 bg-muted-foreground/20 sm:w-4")
              }
            />
          </button>
        );
      })}
    </nav>
  );
}

function ReviewSummary({
  config,
  steps,
  saved,
  onEdit,
}: {
  config: WebsiteConfig;
  steps: WizardStepId[];
  /** False when the draft cannot be saved (see `draftSavable`). */
  saved: boolean;
  onEdit: (step: WizardStepId) => void;
}) {
  const niche = isNicheKey(config.niche) ? NICHE_META[config.niche].label : "Generic";
  const local = (config.build_type ?? "local") === "local";
  const premium = effectiveQuality(config) === "premium";
  const pages = local
    ? (["services", "contact", "privacy", "terms"] as const).filter((p) => config.local_page_selections?.[p])
    : [];
  if (isTemplateConfig(config)) {
    const b = config.business_details;
    const templateRows: Array<{ step: WizardStepId; label: string; value: string }> = [
      { step: "start", label: "Site", value: `Agency template · ${config.template_name || "saved template"}` },
      { step: "location", label: "Business", value: b?.business_name || "—" },
      { step: "location", label: "Email", value: config.contact_details || "—" },
      { step: "location", label: "Phone", value: b?.business_phone || "—" },
      { step: "location", label: "Address", value: [b?.business_street, b?.business_city].filter(Boolean).join(", ") || "—" },
      { step: "location", label: "Main button", value: config.cta_link || "—" },
    ];
    return <SummaryList rows={templateRows} saved={saved} onEdit={onEdit} />;
  }
  const d = config.premium_details;
  const storyCount = d
    ? [d.tagline, d.metrics, d.team, d.testimonials, d.offer_headline, d.gallery_notes, d.social_links, d.reference_notes].filter((v) => v?.trim()).length
    : 0;
  const rows: Array<{ step: WizardStepId; label: string; value: string }> = [
    { step: "start", label: "Site", value: `${premium ? "Premium" : "Standard"} · ${local ? "Multi-page site" : "VSL funnel"} · ${niche}` },
    { step: "business", label: "Heading", value: config.heading || "—" },
    { step: "business", label: "Main button", value: config.cta_link || "—" },
    local
      ? { step: "pages", label: "Pages", value: ["Home", ...pages.map((p) => p[0].toUpperCase() + p.slice(1))].join(", ") }
      : { step: "video", label: "Video", value: config.video_link || "—" },
    ...(steps.includes("location") && config.business_details
      ? [{ step: "location" as const, label: "Address", value: [config.business_details.business_street, config.business_details.business_city].filter(Boolean).join(", ") || "—" }]
      : []),
    { step: "look", label: "Look", value: `${config.color_scheme}${premium ? ` · ${config.concept ? "chosen direction" : "studio's choice"}` : ""}` },
    ...(premium ? [{ step: "story" as const, label: "Your story", value: storyCount ? `${storyCount} section${storyCount === 1 ? "" : "s"} filled` : "Skipped" }] : []),
  ];
  return <SummaryList rows={rows} saved={saved} onEdit={onEdit} />;
}

function SummaryList({
  rows,
  saved,
  onEdit,
}: {
  rows: Array<{ step: WizardStepId; label: string; value: string }>;
  saved: boolean;
  onEdit: (step: WizardStepId) => void;
}) {
  return (
    <dl className="divide-y rounded-xl border">
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
          <dt className="w-28 shrink-0 text-xs text-muted-foreground">{r.label}</dt>
          <dd className="min-w-0 flex-1 truncate">{r.value}</dd>
          <button type="button" onClick={() => onEdit(r.step)} className="shrink-0 text-xs text-primary hover:underline">
            Edit
          </button>
        </div>
      ))}
      {saved ? (
        <div className="flex items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-emerald-600" /> Every step is saved — you can close this and come back.
        </div>
      ) : (
        <div className="px-4 py-2.5 text-xs text-muted-foreground">
          The last build can still finish, so changes here are kept only if you build again.
        </div>
      )}
    </dl>
  );
}
