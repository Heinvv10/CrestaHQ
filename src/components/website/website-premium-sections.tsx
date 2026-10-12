"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Circle,
  Film,
  Image as ImageIcon,
  Wind,
  FileText,
  Loader2,
  MessageSquare,
  Sparkles,
  Workflow,
  XCircle,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PREMIUM_LIMITS, premiumDetailAppliesToNiche } from "@/lib/website/premium";
import { TILE_OFF, TILE_ON } from "@/components/website/website-form-parts";
import {
  blankPremiumDetails,
  type HeroMotion,
  type WebsitePremiumDetails,
  type WebsiteProvisioning,
} from "@/types/website";

/**
 * Website Build v2 — the premium-only sections of the website builder
 * (lead-capture + chat toggles, concept pitch cards, hero motion, premium
 * details, build-phase label, hand-off summary). There is no quality picker:
 * every build is premium. Kept out of `website-builder.tsx` so the long form
 * stays readable; every piece is a plain controlled component — the builder
 * owns the config state.
 */

// ---------------------------------------------------------------------------
// Lead capture + chat toggles

/**
 * One tile. The label wraps only phrasing content (spans), so the HTML is
 * valid; the checkbox is named by the title alone and described by the
 * explanation (`aria-labelledby` / `aria-describedby`).
 */
function ToggleTile({
  checked,
  disabled,
  onCheckedChange,
  icon,
  title,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (next: boolean) => void;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const descId = useId();
  return (
    <label
      className={`${checked ? TILE_ON : TILE_OFF} flex items-start gap-3 rounded-xl border p-3 transition-colors ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }`}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(c) => onCheckedChange(c === true)}
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="mt-0.5"
      />
      <span className="block">
        <span id={titleId} className="flex items-center gap-1.5 text-sm font-medium">
          {icon}
          {title}
        </span>
        <span id={descId} className="block text-xs text-muted-foreground">
          {children}
        </span>
      </span>
    </label>
  );
}

export function LeadCaptureToggles({
  includeForm,
  includeChat,
  onChange,
  disabled,
}: {
  includeForm: boolean;
  includeChat: boolean;
  onChange: (patch: { include_form?: boolean; include_chat?: boolean }) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <ToggleTile
        checked={includeForm}
        disabled={disabled}
        onCheckedChange={(v) => onChange({ include_form: v })}
        icon={<FileText className="h-3.5 w-3.5 text-violet-500 dark:text-violet-300" />}
        title="Contact form feeds this workspace"
      >
        The site&apos;s contact form posts straight into Contacts (a
        &ldquo;Website contact&rdquo; form is created once and reused), and a
        speed-to-lead workflow is set up on it when the site publishes.
      </ToggleTile>
      <ToggleTile
        checked={includeChat}
        disabled={disabled}
        onCheckedChange={(v) => onChange({ include_chat: v })}
        icon={<MessageSquare className="h-3.5 w-3.5 text-violet-500 dark:text-violet-300" />}
        title="AI chat widget on every page"
      >
        The workspace&apos;s Web Chat bubble is embedded, the live hostname
        is allow-listed, and the bot&apos;s knowledge base is seeded from
        the finished site so it can answer questions on day one.
      </ToggleTile>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concept picker

type ConceptsFailure = {
  message: string;
  /** True when the build can still proceed without a picked direction. */
  fallback: boolean;
};

const UNAVAILABLE = "The design service is unavailable right now.";

/**
 * Maps the concepts route's stable `code` (see the route) to operator copy.
 * Only `gate_off` shows the route's own text (our fixed string naming the
 * gate); everything else is fixed here. A reply with no code (a proxy or
 * limiter in front of the route) falls back on 429, else generic copy.
 */
function describeConceptsFailure(status: number, code: unknown, routeError: unknown): ConceptsFailure {
  switch (code) {
    case "unauthorized":
      return { message: "Your session has expired — sign in again to load design directions.", fallback: false };
    case "forbidden":
      return { message: "You do not have access to build websites in this workspace.", fallback: false };
    case "gate_off":
      return {
        message:
          typeof routeError === "string" && routeError.trim()
            ? routeError.trim()
            : "The website builder is disabled for this workspace.",
        fallback: false,
      };
    case "not_found":
      return { message: "This workspace could not be found.", fallback: false };
    case "not_configured":
      return { message: "Website building is not set up on this deployment.", fallback: false };
    case "bad_niche":
      return { message: "That industry template has no design directions.", fallback: true };
    case "upstream":
      return { message: UNAVAILABLE, fallback: true };
  }
  if (status === 429) return { message: "Too many requests — wait a moment, then reopen this step.", fallback: true };
  if (status >= 500) return { message: UNAVAILABLE, fallback: true };
  return { message: "Could not load design directions.", fallback: true };
}

/** A concept card reduced to what the picker renders, every field checked. */
type PickerCard = {
  id: string;
  name: string;
  pitch: string;
  fit: string;
  archetype: string;
  typeSystem: string;
  /** Validated hex colours per mode; anything else is dropped. */
  accents: Record<string, string>;
  defaultMode: string;
};

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toPickerCard(raw: unknown): PickerCard | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || !c.id || typeof c.name !== "string") return null;
  const rawAccents = c.accents && typeof c.accents === "object" ? (c.accents as Record<string, unknown>) : {};
  const accents: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawAccents)) {
    if (typeof v === "string" && HEX_COLOR.test(v)) accents[k] = v;
  }
  return {
    id: c.id,
    name: c.name,
    pitch: str(c.pitch),
    fit: str(c.fit),
    archetype: str(c.archetype),
    typeSystem: str(c.typeSystem),
    accents,
    defaultMode: str(c.defaultMode) || "light",
  };
}

export function ConceptPicker({
  subAccountId,
  niche,
  mode,
  value,
  onChange,
  disabled,
}: {
  subAccountId: string;
  niche: string | null;
  mode: "light" | "dark";
  value: string | null;
  onChange: (conceptId: string | null) => void;
  disabled?: boolean;
}) {
  const [cards, setCards] = useState<PickerCard[] | null>(null);
  const [failure, setFailure] = useState<ConceptsFailure | null>(null);

  // The fetch effect must not re-run when the parent re-renders with a new
  // `value`/`onChange`, but its success branch needs the latest ones.
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  useEffect(() => {
    let cancelled = false;
    setCards(null);
    setFailure(null);
    const qs = niche ? `?niche=${encodeURIComponent(niche)}` : "";
    (async () => {
      try {
        const res = await fetch(
          `/api/sub-accounts/${encodeURIComponent(subAccountId)}/website/concepts${qs}`,
        );
        const body = (await res.json().catch(() => ({}))) as {
          concepts?: unknown;
          error?: unknown;
          code?: unknown;
        };
        if (cancelled) return;
        if (!res.ok) {
          // A failed load says nothing about the saved selection: leave it.
          setFailure(describeConceptsFailure(res.status, body.code, body.error));
          setCards([]);
          return;
        }
        const list = (Array.isArray(body.concepts) ? body.concepts : [])
          .map(toPickerCard)
          .filter((c): c is PickerCard => c !== null);
        setCards(list);
        // Only a SUCCESSFUL list can say the saved concept does not exist
        // (e.g. it belonged to another niche).
        const { value: current, onChange: change } = latest.current;
        if (current && !list.some((c) => c.id === current)) change(null);
      } catch {
        if (cancelled) return;
        setFailure({ message: "Could not reach the server to load design directions.", fallback: true });
        setCards([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subAccountId, niche]);

  if (cards === null) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading design directions…
      </p>
    );
  }
  if (failure) {
    const kept = value !== null;
    return (
      <p role={failure.fallback ? "status" : "alert"} className="text-xs text-muted-foreground">
        {failure.message}
        {failure.fallback
          ? kept
            ? " Your chosen design direction is kept."
            : " gitpage will pick the niche's default direction."
          : ""}
      </p>
    );
  }

  return (
    <div role="group" aria-label="Design direction" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <button
        type="button"
        onClick={() => onChange(null)}
        disabled={disabled}
        aria-pressed={value === null}
        className={
          (value === null ? TILE_ON : TILE_OFF) +
          " flex flex-col items-start gap-1 rounded-xl border border-dashed p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        <p className="text-sm font-medium">Let the studio choose</p>
        <p className="text-[11px] text-muted-foreground">
          gitpage picks the direction that fits this niche best.
        </p>
      </button>
      {cards.map((c) => {
        const selected = value === c.id;
        const accent = c.accents[mode] ?? c.accents[c.defaultMode];
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            disabled={disabled}
            aria-pressed={selected}
            className={
              (selected ? TILE_ON : TILE_OFF) +
              " flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            }
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                data-testid="concept-swatch"
                className="inline-block h-4 w-4 rounded-full border border-black/10 bg-muted dark:border-white/25"
                style={accent ? { backgroundColor: accent } : undefined}
              />
              <span className="text-sm font-medium">{c.name}</span>
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">{c.pitch}</p>
            {c.fit && (
              <p className="text-[10px] text-muted-foreground/80">
                <span className="font-medium">Fits:</span> {c.fit}
              </p>
            )}
            {(c.archetype || c.typeSystem) && (
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {[c.archetype, c.typeSystem.replace(/_/g, " ")].filter(Boolean).join(" · ")}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Hero treatment as option cards. `null` is "the concept's default" (the
 * client omits `heroMotion` for it), so it is its own selectable option and
 * is what shows when nothing was chosen.
 */
export function HeroMotionSelect({
  value,
  onChange,
  disabled,
}: {
  value: HeroMotion | null;
  onChange: (next: HeroMotion | null) => void;
  disabled?: boolean;
}) {
  const labelId = useId();
  const options: Array<{ id: HeroMotion | null; label: string; hint: string; Icon: typeof Film }> = [
    { id: null, label: "Concept default", hint: "Whatever the chosen design direction does by default.", Icon: Sparkles },
    { id: "still", label: "Photo", hint: "A generated hero photograph. Fastest and lightest.", Icon: ImageIcon },
    { id: "loop", label: "Video loop", hint: "A 5-second silent video made from the hero photo. Takes a little longer to build.", Icon: Film },
    { id: "atmosphere", label: "Animated background", hint: "Soft moving light and grain over the brand colours — no photo needed.", Icon: Wind },
  ];
  return (
    <div className="space-y-2">
      <p id={labelId} className="text-sm font-medium">Hero</p>
      <div role="group" aria-labelledby={labelId} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {options.map((o) => {
          const selected = value === o.id;
          return (
            <button
              key={o.id ?? "default"}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(o.id)}
              className={(selected ? TILE_ON : TILE_OFF) + " flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"}
            >
              <span className={(selected ? "bg-violet-500 text-white" : "bg-violet-500/10 text-violet-500 dark:text-violet-300") + " flex h-7 w-7 items-center justify-center rounded-lg"}>
                <o.Icon className="h-4 w-4" />
              </span>
              <span className="text-sm font-medium">{o.label}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{o.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">Visitors who prefer reduced motion always see the still photo.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Premium details

type DetailKey = keyof WebsitePremiumDetails;

const DETAIL_FIELDS: Array<{
  key: DetailKey;
  label: string;
  hint: string;
  rows?: number;
  input?: boolean;
  placeholder?: string;
}> = [
  { key: "tagline", label: "Tagline", hint: `One line, ≤${PREMIUM_LIMITS.tagline} characters.`, input: true, placeholder: "Rituals that elevate your training." },
  { key: "founded_year", label: "Founded", hint: "Four-digit year.", input: true, placeholder: "2011" },
  { key: "brand_voice", label: "Brand voice", hint: `Up to ${PREMIUM_LIMITS.brandVoice} words, comma-separated — how the copy should sound.`, input: true, placeholder: "direct, athletic, warm" },
  { key: "metrics", label: "Numbers you can stand behind", hint: `One per line as "Label: Value" (≤${PREMIUM_LIMITS.metrics}). Only real figures — nothing is invented.`, rows: 4, placeholder: "Google rating: 4.9\nJobs completed: 40,000+" },
  { key: "team", label: "Team", hint: `One per line: "Name | Role | Credentials | What they do" (≤${PREMIUM_LIMITS.team}).`, rows: 4, placeholder: "Mia Carter | Head Coach | CSCS · USAW L2 | Barbell strength programming" },
  { key: "testimonials", label: "Testimonials", hint: `One per line: "Quote | Name | Role" (≤${PREMIUM_LIMITS.testimonials}). Real quotes only.`, rows: 4, placeholder: "They fixed it the same day and the price matched the quote. | Rachel N. | Homeowner" },
  { key: "offer_headline", label: "Offer headline", hint: `≤${PREMIUM_LIMITS.offerHeadline} characters.`, input: true, placeholder: "Start with your free week on us." },
  { key: "offer_bullets", label: "Offer bullets", hint: `One per line (≤${PREMIUM_LIMITS.offerBullets}).`, rows: 3 },
  { key: "offer_fine", label: "Offer fine print", hint: `≤${PREMIUM_LIMITS.offerFine} characters.`, input: true },
  { key: "gallery_notes", label: "Photography notes", hint: `Art direction for the generated images (≤${PREMIUM_LIMITS.galleryNotes} characters).`, rows: 3, placeholder: "Moody interiors, black steel, one yellow accent wall; a single athlete under side light." },
  { key: "social_links", label: "Social links", hint: `One per line: "Label | https://…" (≤${PREMIUM_LIMITS.socialLinks}).`, rows: 2, placeholder: "Instagram | https://instagram.com/yourbrand" },
  { key: "case_studies", label: "Case studies", hint: `One per line: "Client | Result | What you did" (≤${PREMIUM_LIMITS.caseStudies}). Real results only — they become the results strip when you haven't added numbers.`, rows: 4, placeholder: "Northgate Freight | 3 days → 2 hours reporting | Automated month-end reporting across the TMS and accounting" },
  { key: "tools", label: "Tools & platforms you work with", hint: `Comma-separated (≤${PREMIUM_LIMITS.tools}). Named on the site only if you list them here.`, input: true, placeholder: "n8n, Make, Zapier, OpenAI, Claude" },
  { key: "reference_notes", label: "Anything else", hint: `Notes for the copywriter — positioning, what to avoid, a reference site (≤${PREMIUM_LIMITS.referenceNotes} characters).`, rows: 3 },
];

function DetailField({
  field,
  value,
  error,
  onChange,
}: {
  field: (typeof DETAIL_FIELDS)[number];
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const shared = {
    id,
    value,
    placeholder: field.placeholder,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": noteId,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => onChange(e.target.value),
  } as const;
  return (
    <div className={field.input ? "space-y-1.5" : "space-y-1.5 sm:col-span-2"}>
      <Label htmlFor={id}>{field.label}</Label>
      {field.input ? <Input {...shared} /> : <Textarea rows={field.rows ?? 3} {...shared} />}
      <p id={noteId} className={error ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"}>
        {error ?? field.hint}
      </p>
    </div>
  );
}

export function PremiumDetailsFields({
  value,
  errors,
  onChange,
  niche = null,
}: {
  value: WebsitePremiumDetails | null;
  errors: Record<string, string>;
  onChange: (next: WebsitePremiumDetails) => void;
  niche?: string | null;
}) {
  const details = value ?? blankPremiumDetails();
  const set = (key: DetailKey, v: string) => onChange({ ...details, [key]: v });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {DETAIL_FIELDS.filter((f) => premiumDetailAppliesToNiche(f.key, niche)).map((f) => (
        <DetailField
          key={f.key}
          field={f}
          value={details[f.key] ?? ""}
          error={errors[`premium_details.${f.key}`]}
          onChange={(v) => set(f.key, v)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build phase + hand-off summary

const PHASE_LABEL: Record<string, string> = {
  brief: "writing the brief",
  repo: "creating the repository",
  images_submit: "commissioning photography",
  images_wait: "generating photography",
  render: "designing the pages",
  deploy: "publishing",
  seo_finalize: "finalising the address for Google",
  settle: "finishing up",
  completed: "done",
};

export function premiumPhaseLabel(phase: string | null | undefined): string | null {
  if (!phase) return null;
  return PHASE_LABEL[phase] ?? phase.replace(/_/g, " ");
}

export function ProvisioningSummary({
  provisioning,
  subAccountId,
}: {
  provisioning: WebsiteProvisioning;
  subAccountId: string;
}) {
  const rows: Array<{ ok: boolean | null; icon: React.ReactNode; text: React.ReactNode }> = [
    {
      ok: !!provisioning.formId,
      icon: <FileText className="h-3.5 w-3.5" />,
      text: provisioning.formId ? (
        <>
          Contact form wired —{" "}
          <a className="text-primary hover:underline" href={`/sa/${subAccountId}/forms/${provisioning.formId}`}>
            Website contact
          </a>
        </>
      ) : (
        "No contact form on this build."
      ),
    },
    {
      ok: provisioning.chatEnabled ? true : provisioning.chatAllowlisted ? null : false,
      icon: <Bot className="h-3.5 w-3.5" />,
      text: provisioning.chatEnabled ? (
        <>
          AI chat is live on {provisioning.hostname ?? "the site"}
          {provisioning.kbSeeded ? " with a knowledge base seeded from the site" : ""} —{" "}
          <a className="text-primary hover:underline" href={`/sa/${subAccountId}/ai-agents/web-chat`}>
            Web Chat settings
          </a>
        </>
      ) : provisioning.chatSkippedReason ? (
        `Chat widget on the site, bot not switched on: ${provisioning.chatSkippedReason}`
      ) : (
        "Chat not included."
      ),
    },
    {
      ok: provisioning.workflowStatus === "active" ? true : provisioning.workflowId ? null : false,
      icon: <Workflow className="h-3.5 w-3.5" />,
      text: provisioning.workflowId ? (
        <>
          Speed-to-lead workflow{" "}
          {provisioning.workflowStatus === "active" ? "published" : "saved as a draft (no SMS/email channel ready yet)"}
          {provisioning.workflowChannels.length ? ` — ${provisioning.workflowChannels.map(labelChannel).join(", ")}` : ""}{" "}
          —{" "}
          <a className="text-primary hover:underline" href={`/sa/${subAccountId}/workflows/${provisioning.workflowId}`}>
            open
          </a>
        </>
      ) : (
        "No speed-to-lead workflow (needs the contact form)."
      ),
    },
  ];
  return (
    <div className="border-t px-4 py-3">
      <p className="text-xs font-medium">Wired up on publish</p>
      <ul className="mt-1.5 space-y-1 text-xs">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-muted-foreground">
            <span className={r.ok === true ? "text-emerald-600 dark:text-emerald-400" : r.ok === null ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/60"}>
              {r.ok === true ? <CheckCircle2 className="mt-px h-3.5 w-3.5" /> : r.ok === null ? <Circle className="mt-px h-3.5 w-3.5" /> : <XCircle className="mt-px h-3.5 w-3.5" />}
            </span>
            <span className="flex items-start gap-1.5">
              <span className="mt-px shrink-0 text-muted-foreground/70">{r.icon}</span>
              <span>{r.text}</span>
            </span>
          </li>
        ))}
        {provisioning.errors.length > 0 && (
          <li className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
            Some steps need attention: {provisioning.errors.join(" · ")}
          </li>
        )}
      </ul>
    </div>
  );
}

function labelChannel(type: string): string {
  switch (type) {
    case "send_sms":
      return "instant SMS";
    case "send_email":
      return "instant email";
    case "notify":
      return "team alert";
    default:
      return type.replace(/_/g, " ");
  }
}
