import "server-only";

import {
  effectiveQuality,
  wantsChatWidget,
  wantsLeadForm,
  type WebsiteConfig,
} from "@/types/website";
import { isNicheKey, NICHE_FORCED_PAGES } from "@/lib/website/niches";
import { isTemplateConfig, TEMPLATE_ID_RE } from "@/lib/website/templates";
import {
  premiumDetailsPayload,
  premiumModeFor,
} from "@/lib/website/premium";
import { isBlockedHostname } from "@/lib/webhooks/validate-url";

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
  /**
   * Set when the body carried a live URL that was REFUSED (`safePagesUrl`):
   * the offered value, cleaned and cut for display. Distinguishes "gitpage
   * has no address yet" (both null — keep polling) from "gitpage gave an
   * address we will not store" (settle as failed and say so).
   */
  pagesUrlRefused: string | null;
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

/**
 * Bounds on what a status answer or a `build.settled` body may put on a site
 * doc. The doc is read by every member's browser, and these strings come
 * from outside: a signed body is still someone else's data.
 */
const MAX_PAGES_URL_LENGTH = 2048;
const MAX_ERROR_LENGTH = 500;
const MAX_LABEL_LENGTH = 120;
const MAX_PARTIAL_ERRORS = 20;
const MAX_REFUSED_URL_LENGTH = 200;

/**
 * Text from gitpage made safe to store and show: every run of control
 * characters (newlines and tabs included, C1 and the Unicode line/paragraph
 * separators too) becomes one space, the ends are trimmed, and the result is
 * cut to `max`. Null for anything that is not a string or is empty after
 * that. These strings reach the site card and the assistant's
 * `check_website_status` answer, where a newline is how one line of status
 * turns into several lines of someone else's instructions.
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/**
 * The live URL gitpage reports, or null unless it is a plain public https
 * address: trimmed first, then at most 2,048 characters, no whitespace or
 * control characters inside it (`new URL` silently strips tabs and newlines,
 * so they are refused before parsing), parses, `https:`, no embedded
 * credentials, and not localhost or
 * a non-public IP literal. The card renders it as a link and the hand-off
 * will allow-list its host, so `javascript:`, `data:` and `http:` never get
 * as far as the doc. Returned in `URL.href` form.
 */
export function safePagesUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (isBlockedHostname(url.hostname)) return null;
  return url.href.length <= MAX_PAGES_URL_LENGTH ? url.href : null;
}

function readPremium(body: Record<string, unknown>): GitpagePremiumStatus | null {
  if (body.quality !== "premium") return null;
  const persona = body.agentPersona as Partial<GitpageAgentPersona> | undefined;
  const theme = body.theme as Partial<GitpageTheme> | undefined;
  return {
    quality: "premium",
    concept: cleanText(body.concept, MAX_LABEL_LENGTH),
    estimatedDurationSeconds:
      typeof body.estimatedDurationSeconds === "number" ? body.estimatedDurationSeconds : null,
    failedStage: cleanText(body.failedStage, MAX_LABEL_LENGTH),
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
            ...(cleanText(theme.conceptName, MAX_LABEL_LENGTH) && {
              conceptName: cleanText(theme.conceptName, MAX_LABEL_LENGTH)!,
            }),
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
  // A status that is not a string (a number, an object, missing) reads as
  // still in flight, never as a TypeError.
  const rawStatus = typeof body.status === "string" ? body.status : "processing";
  const statusPhase = cleanText(body.statusPhase, MAX_LABEL_LENGTH);
  const pagesUrl = safePagesUrl(body.pagesUrl);
  // Present but refused. An empty or missing value is "no address yet".
  const offered = body.pagesUrl;
  const pagesUrlRefused =
    pagesUrl !== null || offered === undefined || offered === null
      ? null
      : typeof offered === "string"
        ? cleanText(offered, MAX_REFUSED_URL_LENGTH)
        : "a value that is not text";
  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : null;
  const error = cleanText(body.error, MAX_ERROR_LENGTH);
  const updatedAt =
    typeof body.updatedAt === "string" ? body.updatedAt : null;
  const partialErrors = Array.isArray(body.partialErrors)
    ? body.partialErrors
        .filter((v): v is string => typeof v === "string")
        .map((v) => cleanText(v, MAX_ERROR_LENGTH))
        .filter((v): v is string => v !== null)
        .slice(0, MAX_PARTIAL_ERRORS)
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
    pagesUrlRefused,
    repoUrl,
    error,
    partialErrors: partialErrors && partialErrors.length > 0 ? partialErrors : null,
    isTerminal,
    updatedAt,
    premium: readPremium(body),
    // An id is used whole or not at all: an over-long one is not an id.
    pageId:
      typeof body.pageId === "string" &&
      body.pageId.length <= MAX_LABEL_LENGTH &&
      cleanText(body.pageId, MAX_LABEL_LENGTH) === body.pageId
        ? body.pageId
        : null,
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
/** HARDENING: how long the concepts proxy waits for gitpage. */
export const CONCEPTS_TIMEOUT_MS = 8000;

export async function fetchConcepts(
  niche: string | null,
): Promise<GitpageConceptCard[]> {
  const url = `${getBaseUrl()}/api/v1/concepts${niche ? `?niche=${encodeURIComponent(niche)}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    next: { revalidate: 300 },
    // HARDENING: a hung gitpage must not hold the picker's request open; the timeout rejects and the route answers 502.
    signal: AbortSignal.timeout(CONCEPTS_TIMEOUT_MS),
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
  // HARDENING: an ok answer without a concepts array (a 200 maintenance page, a reshaped body) is a failure, not "no concepts".
  if (!Array.isArray(body.concepts)) {
    throw new GitpageError("gitpage concepts answer has no concepts array", 502, body);
  }
  return body.concepts
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
// fetchTemplates — the agency's saved templates (gitpage My Sites → "Save as template")

export interface GitpageTemplate {
  templateId: string;
  name: string;
  /** Niche key, or null when the template suits any niche. */
  niche: string | null;
  previewUrl: string | null;
  quality: "premium" | "standard";
  savedAt: string | null;
  updatedAt: string | null;
  /** "agency": offered to every client; "client": one client's own (only that sub-account sees it). */
  scope: "agency" | "client";
}

/**
 * GET /api/v1/templates — the agency's Agency templates, plus the client's
 * own when `subAccountId` is given. gitpage answers 404
 * while templates aren't enabled for the account (and older gitpage versions
 * don't have the route): both mean "not available", never an error.
 * `enabled` with an empty list means "available, none saved yet".
 */
export async function fetchTemplates(
  subAccountId?: string,
): Promise<{ enabled: boolean; templates: GitpageTemplate[]; clientTemplates: boolean }> {
  const query = subAccountId ? `?subAccountId=${encodeURIComponent(subAccountId)}` : "";
  const res = await fetch(`${getBaseUrl()}/api/v1/templates${query}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return { enabled: false, templates: [], clientTemplates: false };
  const body = await readTemplatesBody(res, "GET");
  const list = Array.isArray(body.templates) ? body.templates : [];
  return {
    enabled: true,
    templates: list.map(toTemplate).filter((t): t is GitpageTemplate => !!t),
    // Older gitpage versions don't know client templates (they'd save one agency-wide).
    clientTemplates: body.clientTemplates === true,
  };
}

/**
 * Save one of the agency's gitpage sites (its `gitpagePageId`) as an Agency
 * template, or rename it — POST /api/v1/templates.
 *   client  save it as that client's own template, acting as the client (it
 *           can't change agency templates)
 *   scope   (agency owner) "agency" | "client" (only the client the site was
 *           built for); left out, a rename keeps the current scope and a new
 *           template is for every client
 */
export async function saveTemplate(
  pageId: string,
  name: string,
  opts: { client?: string; scope?: "agency" | "client" } = {},
): Promise<GitpageTemplate | null> {
  const payload: Record<string, unknown> = { pageId, name };
  if (opts.client) Object.assign(payload, { actingAs: "client", subAccountId: opts.client });
  else if (opts.scope) payload.scope = opts.scope;
  const res = await fetch(`${getBaseUrl()}/api/v1/templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new GitpageError(
      typeof (body as { error?: unknown }).error === "string" && (body as { error: string }).error !== "Not found"
        ? (body as { error: string }).error
        : "Agency templates aren't switched on for this gitpage account.",
      404,
      body,
    );
  }
  const body = await readTemplatesBody(res, "POST");
  return toTemplate(body.template);
}

/**
 * Stop a gitpage site being an Agency template — DELETE /api/v1/templates.
 * With `client` (a sub-account id) only that client's own templates.
 */
export async function removeTemplate(pageId: string, client?: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/v1/templates`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(client ? { pageId, actingAs: "client", subAccountId: client } : { pageId }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  await readTemplatesBody(res, "DELETE");
}

async function readTemplatesBody(res: Response, method: string): Promise<Record<string, unknown>> {
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
          : `gitpage ${method} failed: ${res.status}`;
    throw new GitpageError(message, res.status, body);
  }
  return body;
}

function toTemplate(t: unknown): GitpageTemplate | null {
  if (!t || typeof t !== "object") return null;
  const r = t as Record<string, unknown>;
  // HARDENING: ids, names and URLs from gitpage are checked here, before they
  // are stored or shipped to the browser. A template id goes back to gitpage
  // in build payloads, the preview URL renders as a link.
  const name = cleanText(r.name, MAX_GITPAGE_NAME_LENGTH);
  if (typeof r.templateId !== "string" || !TEMPLATE_ID_RE.test(r.templateId) || !name) return null;
  const str = (v: unknown) => cleanText(v, 64);
  return {
    templateId: r.templateId,
    name,
    niche: str(r.niche),
    previewUrl: safePagesUrl(r.previewUrl),
    quality: r.quality === "premium" ? "premium" : "standard",
    savedAt: str(r.savedAt),
    updatedAt: str(r.updatedAt),
    scope: r.scope === "client" ? "client" : "agency",
  };
}

/** HARDENING: longest template / repo name kept from gitpage. */
const MAX_GITPAGE_NAME_LENGTH = 120;

/** HARDENING: a plain lowercase hostname, else null (gitpage's verified custom domain). */
const CUSTOM_DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

function safeCustomDomain(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const host = v.trim().toLowerCase();
  return CUSTOM_DOMAIN_RE.test(host) ? host : null;
}

// ---------------------------------------------------------------------------
// Client sites — sites gitpage holds for one sub-account (incl. copies the
// client made in gitpage with Duplicate)

export interface GitpageClientSite {
  pageId: string;
  repoName: string | null;
  status: string | null;
  liveUrl: string | null;
  /** Verified custom domain, else null. */
  customDomain: string | null;
  quality: "premium" | "standard";
  /** "duplicate": made in gitpage (no LeadStack build); "build": a LeadStack build. */
  origin: "duplicate" | "build";
  /** The pageId it was copied from, or null. */
  duplicatedFrom: string | null;
  createdAt: string | null;
}

/**
 * GET /api/v1/sites?subAccountId= — the sub-account's visible gitpage sites.
 * Older gitpage versions don't have the route: 404 means "none".
 */
export async function fetchClientSites(subAccountId: string): Promise<GitpageClientSite[]> {
  const res = await fetch(`${getBaseUrl()}/api/v1/sites?subAccountId=${encodeURIComponent(subAccountId)}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return [];
  const body = await readTemplatesBody(res, "GET sites");
  const list = Array.isArray(body.sites) ? body.sites : [];
  const str = (v: unknown) => cleanText(v, 64);
  const id = (v: unknown) => (typeof v === "string" && TEMPLATE_ID_RE.test(v) ? v : null);
  return list.flatMap((s: unknown): GitpageClientSite[] => {
    if (!s || typeof s !== "object") return [];
    const r = s as Record<string, unknown>;
    // HARDENING: the pageId becomes part of Firestore doc ids (`gp-<pageId>`,
    // websiteDismissed/<pageId>), so anything but a gitpage ObjectId is dropped.
    const pageId = id(r.pageId);
    if (!pageId) return [];
    return [{
      pageId,
      repoName: cleanText(r.repoName, MAX_GITPAGE_NAME_LENGTH),
      status: str(r.status),
      liveUrl: safePagesUrl(r.liveUrl),
      customDomain: safeCustomDomain(r.customDomain),
      quality: r.quality === "premium" ? "premium" : "standard",
      origin: r.origin === "duplicate" ? "duplicate" : "build",
      duplicatedFrom: id(r.duplicatedFrom),
      createdAt: str(r.createdAt),
    }];
  });
}

/**
 * Tell gitpage a sub-account's current name (its sites are grouped by client
 * in gitpage's My Sites) — POST /api/v1/sites. Older gitpage versions answer
 * 400/404: ignored by the caller.
 */
export async function renameClientSites(subAccountId: string, subAccountName: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/v1/sites`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "rename", subAccountId, subAccountName }),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  await readTemplatesBody(res, "rename client");
}

/**
 * Hide a sub-account's site in gitpage (LeadStack "Delete website") — POST
 * /api/v1/sites. It stays live; the agency can unhide it in gitpage.
 */
export async function hideClientSite(
  pageId: string,
  subAccountId: string,
  /** "replaced": a rebuild made a new site (gitpage then keeps templates and sites with a domain). */
  reason?: "replaced",
): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/v1/sites`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "hide", pageId, subAccountId, ...(reason && { reason }) }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  await readTemplatesBody(res, "hide site");
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
 * Agency template build (gitpage `buildType: "template"`): the template id,
 * the new business's details and the LeadStack wiring. The template supplies
 * the design, pages and copy, so none of those fields are sent. The form and
 * chat-widget wiring is sent whenever it exists: gitpage refuses the build if
 * the template has a form or widget it can't re-point to this sub-account.
 */
function templatePayload(input: SubmitBuildInput): Record<string, unknown> {
  const c = input.config;
  const b = c.business_details;
  const t = (v: string | undefined | null) => (typeof v === "string" ? v.trim() : "");
  const ls = input.leadstack;
  return {
    buildType: "template",
    templateId: c.template_id,
    subAccountId: input.subAccountId,
    ...(input.subAccountName ? { subAccountName: input.subAccountName } : {}),
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    ...(input.editorEmail ? { editorEmail: input.editorEmail } : {}),
    businessName: t(b?.business_name),
    // The contact email is the field the template step shows.
    businessEmail: t(c.contact_details) || t(b?.business_email),
    ...(t(b?.business_phone) && { businessPhone: t(b?.business_phone) }),
    ...(t(b?.business_street) && { businessStreet: t(b?.business_street) }),
    ...(t(b?.business_city) && { businessCity: t(b?.business_city) }),
    ...(t(b?.business_state) && { businessState: t(b?.business_state) }),
    ...(t(b?.business_zip) && { businessZip: t(b?.business_zip) }),
    ...(t(b?.business_country) && { businessCountry: t(b?.business_country) }),
    // Replaces the template's booking / main button link (gitpage asks for it when the template has one).
    ...(t(c.cta_link) && { ctaLink: t(c.cta_link) }),
    ...(ls
      ? {
          leadstack: {
            appUrl: ls.appUrl,
            subAccountId: ls.subAccountId,
            ...(ls.formId && ls.formSubmitUrl ? { formId: ls.formId, formSubmitUrl: ls.formSubmitUrl } : {}),
            ...(ls.widgetScriptUrl ? { widgetScriptUrl: ls.widgetScriptUrl } : {}),
          },
        }
      : {}),
  };
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
  // Agency template builds have their own small payload (gitpage copies the
  // template's design and pages); local and vsl payloads below are unchanged.
  if (isTemplateConfig(c)) return templatePayload(input);
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
      // HARDENING: pass the niche so fields the form hides for it are not sent.
      ...premiumDetailsPayload(c.premium_details, c.niche ?? null),
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
