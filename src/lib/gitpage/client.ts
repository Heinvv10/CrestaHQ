import "server-only";

import {
  effectiveQuality,
  wantsChatWidget,
  wantsLeadForm,
  type WebsiteConfig,
} from "@/types/website";
import { isNicheKey, NICHE_FORCED_PAGES } from "@/lib/website/niches";
import {
  premiumDetailsPayload,
  premiumModeFor,
} from "@/lib/website/premium";

/**
 * The Claude tier LeadStack forces for premium builds. gitpage's own users
 * pick their tier on the dashboard (Haiku by default); LeadStack-triggered
 * premium builds always run the brief on Opus so quality doesn't depend on
 * the agency's gitpage preference. gitpage still requires the agency's
 * gitpage account to hold a Claude/OpenRouter key.
 */
export const PREMIUM_CLAUDE_MODEL = "opus-5.5";

/**
 * gitpage.site client — wraps the v1 API calls we need:
 *   - submitBuild  → POST /api/v1/generate-site   (buildType: "local" | "vsl")
 *   - pollBuild    → GET  /api/v1/page-status?formResponseId=...
 *
 * Auth: agency-level API key via Authorization: Bearer header.
 * Base URL is hard-coded in the spec but configurable via GITPAGE_API_URL
 * for local mocking.
 *
 * v1 contract is frozen — additions ship into v1, breaking changes land at
 * /api/v2/. See LEADSTACK_INTEGRATION.md for the full spec.
 *
 * If env vars aren't set, both functions throw — callers translate that to
 * a 503 to the client (mirrors the existing pattern in
 * /api/comms/email/send and /api/automations/step).
 */

const DEFAULT_BASE_URL = "https://www.gitpage.site";

function getBaseUrl(): string {
  return (
    // `||`, not `??`: .env.example ships `GITPAGE_API_URL=` empty.
    process.env.GITPAGE_API_URL?.replace(/\/$/, "") || DEFAULT_BASE_URL
  );
}

function getApiKey(): string {
  const key = process.env.GITPAGE_API_KEY;
  if (!key) {
    throw new Error(
      "GITPAGE_API_KEY is not set. Add it to .env.local + Vercel env vars.",
    );
  }
  return key;
}

export function gitpageIsConfigured(): boolean {
  return !!process.env.GITPAGE_API_KEY;
}

// ---------------------------------------------------------------------------
// submitBuild

export interface SubmitBuildInput {
  config: WebsiteConfig;
  subAccountId: string;
  /** Human-readable label, surfaced in gitpage's reporting. */
  subAccountName?: string;
  /** If set, gitpage POSTs `build.settled` here when the build finishes. */
  callbackUrl?: string;
  /**
   * The LeadStack user who started the build. gitpage invites this email as
   * an "editor" on the new site (content + publish, no settings) so they can
   * edit it with the GitPage MCP. Skipped by gitpage when it's the owner.
   */
  editorEmail?: string;
  /**
   * Premium only — the LeadStack endpoints gitpage bakes into the site so
   * the contact form posts to THIS sub-account and the chat widget loads
   * for it. All must be https URLs under `appUrl` (gitpage validates).
   */
  leadstack?: {
    appUrl: string;
    subAccountId: string;
    formId?: string;
    formSubmitUrl?: string;
    widgetScriptUrl?: string;
  };
}

export interface SubmitBuildResult {
  formResponseId: string;
  pollUrl: string;
  pollIntervalSeconds: number;
  estimatedDurationSeconds: number;
}

export async function submitBuild(
  input: SubmitBuildInput,
): Promise<SubmitBuildResult> {
  const url = `${getBaseUrl()}/api/v1/generate-site`;
  const payload = configToGitpagePayload(input);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // gitpage always returns JSON on the documented codes; if not, fall through.
  }

  if (!res.ok) {
    const baseMessage =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage POST failed: ${res.status}`;
    // gitpage may attach a `details: string[]` for validation failures —
    // include the first one so the operator sees which rule tripped.
    const detail = Array.isArray(body.details)
      ? body.details.find((d) => typeof d === "string")
      : typeof body.details === "string"
        ? body.details
        : null;
    const message = detail ? `${baseMessage} — ${detail}` : baseMessage;
    throw new GitpageError(message, res.status, body);
  }

  if (
    typeof body.formResponseId !== "string" ||
    typeof body.pollUrl !== "string"
  ) {
    throw new GitpageError(
      "gitpage returned 2xx but no formResponseId/pollUrl",
      res.status,
      body,
    );
  }

  return {
    formResponseId: body.formResponseId,
    pollUrl: body.pollUrl,
    pollIntervalSeconds:
      typeof body.pollIntervalSeconds === "number"
        ? body.pollIntervalSeconds
        : 20,
    estimatedDurationSeconds:
      typeof body.estimatedDurationSeconds === "number"
        ? body.estimatedDurationSeconds
        : 300,
  };
}

// ---------------------------------------------------------------------------
// pollBuild

export type GitpageStatus =
  | "processing"
  | "recovering"
  | "Published"
  | "failed";

export interface PollBuildResult {
  status: GitpageStatus;
  /** Sub-state during processing, e.g. "generating" / "deploying". */
  statusPhase: string | null;
  /** Live URL — populated only when status === "Published". */
  pagesUrl: string | null;
  repoUrl: string | null;
  /** Populated when status === "failed". */
  error: string | null;
  /**
   * gitpage may emit per-page warnings on a successful build (e.g. blog or
   * terms generation failed but home + services succeeded). Surface
   * alongside the live URL.
   */
  partialErrors: string[] | null;
  /** Whether this is a terminal state — caller stops polling. */
  isTerminal: boolean;
  /** ISO timestamp from gitpage. Used for the heartbeat-stuck check. */
  updatedAt: string | null;
  /** Premium (Build v2) additive fields — null/absent on standard builds. */
  premium: GitpagePremiumStatus | null;
  /** gitpage page record id — what the GitPage MCP tools call `pageId`. */
  pageId: string | null;
}

/** Chat-bot persona gitpage derives from the brief (premium publish). */
export interface GitpageAgentPersona {
  systemPrompt: string;
  businessName: string;
  hoursStart: number;
  hoursEnd: number;
  escalationKeywords: string[];
  welcomeMessage: string;
}

/** Theme tokens gitpage reports for the published premium site. */
export interface GitpageTheme {
  primaryColor: string;
  accentInk?: string;
  surface?: string;
  ink?: string;
  mode?: "light" | "dark";
  typeSystem?: string;
  archetype?: string;
  concept?: string;
  conceptName?: string;
}

export interface GitpagePremiumStatus {
  quality: "standard" | "premium";
  concept: string | null;
  estimatedDurationSeconds: number | null;
  failedStage: string | null;
  imageProvider: string | null;
  imageCount: number | null;
  briefSource: string | null;
  /** Hand-off artefacts — only present once Published. */
  kbText: string | null;
  agentPersona: GitpageAgentPersona | null;
  theme: GitpageTheme | null;
}

function readPremium(body: Record<string, unknown>): GitpagePremiumStatus | null {
  if (body.quality !== "premium") return null;
  const persona = body.agentPersona as Partial<GitpageAgentPersona> | undefined;
  const theme = body.theme as Partial<GitpageTheme> | undefined;
  return {
    quality: "premium",
    concept: typeof body.concept === "string" ? body.concept : null,
    estimatedDurationSeconds:
      typeof body.estimatedDurationSeconds === "number" ? body.estimatedDurationSeconds : null,
    failedStage: typeof body.failedStage === "string" ? body.failedStage : null,
    imageProvider: typeof body.imageProvider === "string" ? body.imageProvider : null,
    imageCount: typeof body.imageCount === "number" ? body.imageCount : null,
    briefSource: typeof body.briefSource === "string" ? body.briefSource : null,
    kbText: typeof body.kbText === "string" && body.kbText.trim() ? body.kbText : null,
    agentPersona:
      persona && typeof persona.systemPrompt === "string" && persona.systemPrompt.trim()
        ? {
            systemPrompt: persona.systemPrompt,
            businessName: typeof persona.businessName === "string" ? persona.businessName : "",
            hoursStart: typeof persona.hoursStart === "number" ? persona.hoursStart : 0,
            hoursEnd: typeof persona.hoursEnd === "number" ? persona.hoursEnd : 0,
            escalationKeywords: Array.isArray(persona.escalationKeywords)
              ? persona.escalationKeywords.filter((k): k is string => typeof k === "string")
              : [],
            welcomeMessage:
              typeof persona.welcomeMessage === "string" ? persona.welcomeMessage : "",
          }
        : null,
    theme:
      theme && typeof theme.primaryColor === "string"
        ? {
            primaryColor: theme.primaryColor,
            ...(typeof theme.accentInk === "string" && { accentInk: theme.accentInk }),
            ...(typeof theme.surface === "string" && { surface: theme.surface }),
            ...(typeof theme.ink === "string" && { ink: theme.ink }),
            ...((theme.mode === "light" || theme.mode === "dark") && { mode: theme.mode }),
            ...(typeof theme.typeSystem === "string" && { typeSystem: theme.typeSystem }),
            ...(typeof theme.archetype === "string" && { archetype: theme.archetype }),
            ...(typeof theme.concept === "string" && { concept: theme.concept }),
            ...(typeof theme.conceptName === "string" && { conceptName: theme.conceptName }),
          }
        : null,
  };
}

/**
 * Normalise a `build.settled` callback body (gitpage → LeadStack) into the
 * same shape `pollBuild` returns, so one settle handler serves both paths.
 * The callback carries the same fields as the status endpoint.
 */
export function settledPayloadToPollResult(
  body: Record<string, unknown>,
): PollBuildResult {
  return normalisePollBody(body);
}

export async function pollBuild(
  formResponseId: string,
): Promise<PollBuildResult> {
  const url = `${getBaseUrl()}/api/v1/page-status?formResponseId=${encodeURIComponent(formResponseId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // ignore — fallthrough handles
  }

  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage GET failed: ${res.status}`;
    throw new GitpageError(message, res.status, body);
  }

  return normalisePollBody(body);
}

function normalisePollBody(body: Record<string, unknown>): PollBuildResult {
  const rawStatus = (body.status as string) ?? "processing";
  const statusPhase =
    typeof body.statusPhase === "string" ? body.statusPhase : null;
  const pagesUrl = typeof body.pagesUrl === "string" ? body.pagesUrl : null;
  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : null;
  const error = typeof body.error === "string" ? body.error : null;
  const updatedAt =
    typeof body.updatedAt === "string" ? body.updatedAt : null;
  const partialErrors = Array.isArray(body.partialErrors)
    ? body.partialErrors.filter((v): v is string => typeof v === "string")
    : null;

  // Defensive matching per gitpage's guidance: any string starting with
  // "Published" is terminal-success (covers "Published" and the legacy
  // "Published (Unenhanced)" variant). Case-insensitive "failed" is
  // terminal-failure (covers "failed" and "Failed"). Everything else —
  // including "processing" and the rare "recovering" — is still in flight.
  const status: GitpageStatus = rawStatus.startsWith("Published")
    ? "Published"
    : rawStatus.toLowerCase() === "failed"
      ? "failed"
      : rawStatus === "recovering"
        ? "recovering"
        : "processing";

  const isTerminal = status === "Published" || status === "failed";

  return {
    status,
    statusPhase,
    pagesUrl,
    repoUrl,
    error,
    partialErrors: partialErrors && partialErrors.length > 0 ? partialErrors : null,
    isTerminal,
    updatedAt,
    premium: readPremium(body),
    pageId: typeof body.pageId === "string" && body.pageId ? body.pageId : null,
  };
}

// ---------------------------------------------------------------------------
// fetchConcepts — premium "pitch cards" (three studio-style options per niche)

export interface GitpageConceptCard {
  id: string;
  /** Niche key, or "generic" for the no-niche concepts. */
  niche: string;
  name: string;
  /** One-paragraph studio pitch shown on the picker card. */
  pitch: string;
  /** Who this concept suits. */
  fit: string;
  archetype: string;
  typeSystem: string;
  defaultMode: "light" | "dark";
  modes: string[];
  /** Accent hex per mode, e.g. { light: "#B13F2B", dark: "#F2C14E" }. */
  accents: Record<string, string>;
  heroMotion: string;
}

/**
 * GET /api/v1/concepts?niche=… — read-only, cached by gitpage for 5 min.
 * Pass the niche key, or null for the generic (no-niche) concepts.
 */
export async function fetchConcepts(
  niche: string | null,
): Promise<GitpageConceptCard[]> {
  const url = `${getBaseUrl()}/api/v1/concepts${niche ? `?niche=${encodeURIComponent(niche)}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    next: { revalidate: 300 },
  } as RequestInit);
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // fallthrough
  }
  if (!res.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `gitpage GET failed: ${res.status}`;
    throw new GitpageError(message, res.status, body);
  }
  const list = Array.isArray(body.concepts) ? body.concepts : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => typeof c.id === "string" && typeof c.name === "string")
    .map((c) => ({
      id: c.id as string,
      niche: typeof c.niche === "string" ? c.niche : "generic",
      name: c.name as string,
      pitch: typeof c.pitch === "string" ? c.pitch : "",
      fit: typeof c.fit === "string" ? c.fit : "",
      archetype: typeof c.archetype === "string" ? c.archetype : "",
      typeSystem: typeof c.typeSystem === "string" ? c.typeSystem : "",
      defaultMode: c.defaultMode === "dark" ? "dark" : "light",
      modes: Array.isArray(c.modes) ? c.modes.filter((m): m is string => typeof m === "string") : [],
      accents:
        c.accents && typeof c.accents === "object"
          ? Object.fromEntries(
              Object.entries(c.accents as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === "string",
              ),
            )
          : {},
      heroMotion: typeof c.heroMotion === "string" ? c.heroMotion : "still",
    }));
}

// ---------------------------------------------------------------------------
// Errors + transform

export class GitpageError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = "GitpageError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Map our internal snake_case WebsiteConfig to gitpage's camelCase payload.
 *
 * Branches on `build_type`:
 *   - "local": multi-page LocalSite. Pages array + conditional services /
 *     business sections flattened onto the top-level payload.
 *   - "vsl":   single-page Video Sales Letter. videoLink is required;
 *     pages / business / services / astraTheme are not sent (gitpage
 *     ignores them for vsl).
 *
 * Defaults to "local" when build_type is missing — back-compat for docs
 * written before the VSL feature shipped.
 */
function configToGitpagePayload(input: SubmitBuildInput) {
  const c = input.config;
  const buildType = c.build_type ?? "local";
  // Niche is optional. When set, gitpage swaps in a research-backed design
  // system + section structure. For `local`, gitpage forces the page set
  // to [index, services, contact, privacy, terms] and rejects blog. For
  // `vsl`, gitpage auto-ships privacy + terms. We mirror that here so the
  // payload matches what gitpage validates against.
  const niche = isNicheKey(c.niche) ? c.niche : null;

  // Shared fields — present on every payload regardless of build type.
  const payload: Record<string, unknown> = {
    buildType,
    ...(niche ? { niche } : {}),
    subAccountId: input.subAccountId,
    ...(input.subAccountName ? { subAccountName: input.subAccountName } : {}),
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    ...(input.editorEmail ? { editorEmail: input.editorEmail } : {}),

    heading: c.heading,
    heroStatement: c.hero_statement,
    features: c.features,
    benefits: c.benefits,
    contactEmail: c.contact_details,
    ctaLink: c.cta_link,

    language: c.language,
    colorScheme: c.color_scheme,
    includeFaq: c.include_faq,

    designColorPalette: c.design_color_palette,
    designTypography: c.design_typography,
    designLayout: c.design_layout,
    designComponents: c.design_components,
    designInteractions: c.design_interactions,
    designButtons: c.design_buttons,
    designContactForm: c.design_contact_form,
    designIcons: c.design_icons,
  };

  if (c.design_color_palette === "Custom" && c.custom_colors.trim()) {
    payload.customColors = c.custom_colors.trim();
  }

  // Premium (Build v2): quality + forced Opus tier + the premium block +
  // the LeadStack wiring. Standard builds send none of this, so the v1
  // request stays byte-identical for them.
  if (effectiveQuality(c) === "premium") {
    payload.quality = "premium";
    payload.claudeModel = PREMIUM_CLAUDE_MODEL;
    payload.premium = {
      ...(c.concept && { concept: c.concept }),
      mode: premiumModeFor(c),
      ...(c.hero_motion && { heroMotion: c.hero_motion }),
      ...premiumDetailsPayload(c.premium_details),
    };
    const notes = c.premium_details?.reference_notes?.trim();
    if (notes) payload.referenceNotes = notes;
    if (input.leadstack) {
      const ls = input.leadstack;
      payload.leadstack = {
        appUrl: ls.appUrl,
        subAccountId: ls.subAccountId,
        ...(wantsLeadForm(c) && ls.formId && ls.formSubmitUrl
          ? { formId: ls.formId, formSubmitUrl: ls.formSubmitUrl }
          : {}),
        ...(wantsChatWidget(c) && ls.widgetScriptUrl
          ? { widgetScriptUrl: ls.widgetScriptUrl }
          : {}),
      };
    }
  } else {
    payload.quality = "standard";
  }

  if (buildType === "vsl") {
    payload.videoLink = c.video_link.trim();
    // VSL niche has no pages array — gitpage handles privacy/terms on its side.
    return payload;
  }

  // Local-only fields below.
  payload.astraTheme = c.astra_theme;

  // Pages: niche locks the set to exactly [index, services, contact, privacy,
  // terms]. Generic local builds ship whatever the user picked, plus
  // privacy.html if they opted in (newly allowed by gitpage v1).
  if (niche) {
    payload.pages = [...NICHE_FORCED_PAGES];
  } else {
    const pages: string[] = ["index.html"];
    if (c.local_page_selections.services) pages.push("services.html");
    if (c.local_page_selections.contact) pages.push("contact.html");
    if (c.local_page_selections.privacy) pages.push("privacy.html");
    if (c.local_page_selections.terms) pages.push("terms.html");
    payload.pages = pages;
  }

  // Services: for niche builds, services_list is optional — when omitted,
  // gitpage uses the niche default services seed. User-supplied services
  // always win when present. We send servicesList only when the user
  // explicitly opts out of "let AI do services" and provides a list.
  const includeServices = niche
    ? true
    : c.local_page_selections.services && !!c.services_config;

  if (includeServices && c.services_config) {
    payload.letAiDoServices = c.services_config.let_ai_do_services;
    if (
      !c.services_config.let_ai_do_services &&
      c.services_config.services_list.trim()
    ) {
      payload.servicesList = c.services_config.services_list.trim();
    }
  }

  // Business details: niche forces contact.html on, so business_details are
  // always required and always sent. Generic local builds send them only
  // when the contact page is selected.
  const includeBusiness = niche
    ? !!c.business_details
    : c.local_page_selections.contact && !!c.business_details;

  if (includeBusiness && c.business_details) {
    const b = c.business_details;
    Object.assign(payload, {
      businessName: b.business_name,
      businessStreet: b.business_street,
      businessCity: b.business_city,
      ...(b.business_state && { businessState: b.business_state }),
      ...(b.business_country && { businessCountry: b.business_country }),
      ...(b.business_zip && { businessZip: b.business_zip }),
      ...(b.business_phone && { businessPhone: b.business_phone }),
      ...(b.business_email && { businessEmail: b.business_email }),
      ...(b.opening_hours && { openingHours: b.opening_hours }),
      ...(b.google_rating && { googleRating: b.google_rating }),
      ...(b.google_review_count && {
        googleReviewCount: b.google_review_count,
      }),
    });
  }

  return payload;
}
