import "server-only";

import { isIP } from "node:net";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { MAX_ALLOWED_DOMAINS, transactAiAgentDoc } from "@/lib/comms/ai/agent";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { emailIsConfigured } from "@/lib/comms/resend";
import {
  smsIsConfigured,
  subAccountTwilioIsConfigured,
} from "@/lib/comms/twilio";
import { sendPushForEvent } from "@/lib/push/send";
import { isDocId } from "@/lib/server/doc-id";
import { registrableDomain } from "@/lib/prospecting/registrable-domain";
import {
  readWebVoiceHandoffSnapshot,
  type WebVoiceHandoffSnapshot,
  updateWebVoiceSettings,
  validateWebVoiceHandoff,
} from "@/lib/server/web-voice-service";
import {
  createWorkflowServerSide,
  deleteWorkflowServerSide,
  workflowPatchWrite,
} from "@/lib/server/workflows-service";
import { publicFetch } from "@/lib/webhooks/public-fetch";
import {
  DEFAULT_WEB_CHAT_CONFIG,
  type AiAgentProfile,
  type AiChannelConfig,
} from "@/types/ai";
import type { AgencyDoc, SubAccountDoc } from "@/types/tenancy";
import type { WorkflowDoc, WorkflowNode } from "@/types/workflows";
import {
  wantsChatWidget,
  wantsLeadForm,
  wantsWebVoice,
  type WebsiteConfig,
  type WebsiteDoc,
  type WebsiteProvisioning,
} from "@/types/website";
import { cleanText, safePagesUrl, type PollBuildResult } from "@/lib/gitpage/client";

/**
 * Website Build v2 hand-off: when a PREMIUM gitpage build publishes, do as
 * much of the follow-on setup as possible so the site is ready to work the
 * moment it is live — the sub-account's chat widget may load on it, its
 * contact form feeds the CRM, and a speed-to-lead workflow is waiting for a
 * person to switch on.
 *
 * Runs only while the agency's `websiteEnabledByAgency` gate is on: settling
 * a build keeps the site doc truthful, the hand-off is new work in the
 * workspace. Gate off → null, nothing written.
 *
 * Every step is best-effort and independent: a failure is recorded in
 * `provisioning.errors` and never un-publishes the site. Every write re-reads
 * the site and the gate in its own transaction (`handoffBlocked`): a site
 * removed, rebuilt or switched off mid-hand-off stops it, with the reason
 * recorded. The whole routine is idempotent (safe to run on a rebuild or a
 * duplicate callback):
 *   1. Chat allowlist — append the live hostname to `webChat.allowedDomains`
 *      (cap and append in one transaction), and take the persona's welcome
 *      message + the site's accent colour where the operator has not set
 *      their own (recorded in the same write). Only the host the redirect
 *      walk landed on — never gitpage's reported host when it is shared (a
 *      path URL, or a Pages host reported as-is), which GitLab serves for
 *      every project in a namespace. The channel's `enabled` flag is never
 *      touched (see below).
 *   1b. Web Voice — enable the existing ready connection only when requested;
 *      never disable it and never switch Web Chat on.
 *   2. KB + persona — seed `aiAgent/profile` with gitpage's kbText (replaces
 *      the Firecrawl snapshot; `websiteKbSource: "gitpage-build"`) and fill
 *      persona fields ONLY where blank. ONE profile write.
 *   3. Speed-to-lead — provision ONE workflow pinned to the site's form from
 *      the `speed-to-lead` seed, dropping channel steps the deployment
 *      can't send (SMS/email readiness). Always a DRAFT.
 *   4. Push — tell the team the site is live (fails silently without VAPID).
 *
 * DIFFERENCES FROM UPSTREAM (68798611), all deliberate:
 *   - Nothing here starts talking to leads. Upstream publishes the workflow
 *     when a customer-facing step survives and QStash is set, and switches
 *     the web-chat bot on when OpenRouter and the agency gate allow. Here
 *     the workflow stays a draft and the bot stays as the operator left it;
 *     a person activates each. `provisioning` says what is waiting.
 *   - Every value gitpage supplies is treated as outside data: the accent
 *     must be a #RRGGBB hex, text is control-character-stripped and capped,
 *     hostnames come only from a URL that passes `safePagesUrl` and are never
 *     IP literals; a redirect may only land in the reported host's family
 *     (`inReportedFamily`).
 *   - Upstream allow-lists the reported host too; here it is never added,
 *     and an address the walk could not resolve adds nothing at all.
 *   - The bot's `websiteUrl` follows the published site only while the
 *     operator has not set their own (upstream overwrites it every publish).
 *   - "One form, one workflow" is enforced by a claim in a transaction
 *     (`claimOnce`), not by a query followed by a create.
 */

const KB_MAX_CHARS = 6000;
/** The caps the AI Agents routes apply to an operator's own input. */
const PROMPT_MAX_CHARS = 8000;
const BUSINESS_NAME_MAX_CHARS = 200;
const WELCOME_MAX_CHARS = 400;
const MAX_ESCALATION_KEYWORDS = 25;
const KEYWORD_MAX_CHARS = 100;
const WEBSITE_FORM_NAME = "Website contact";

/** Marker fields stamped on the provisioned workflow for idempotency. */
export const WEBSITE_WORKFLOW_SOURCE = "website-build";

/**
 * `subAccounts/{id}/private/websiteHandoff` — Admin SDK only, under the
 * generic `private/{docId}` deny rule. `contactFormId` and `workflowId`: the
 * ONE "Website contact" form and the ONE speed-to-lead workflow the hand-off
 * made for this sub-account. Two builds for one workspace can reach the
 * "is there one yet?" query at the same moment and both see none; what each
 * creates is then claimed here in a transaction, and the one that loses
 * deletes its own and uses the winner's.
 */
export const websiteHandoffStatePath = (subAccountId: string) =>
  `subAccounts/${subAccountId}/private/websiteHandoff`;

/** Thrown by `claimOnce` when its guard refuses: the claim was not made. */
class HandoffStopped extends Error {}

/**
 * Record `candidate` as the sub-account's one resource of this kind, unless
 * another caller already has. `stale` is the id this caller read from the
 * marker and found dead (deleted since); only that value may be replaced.
 * `guard`, read in the same transaction, may refuse the claim with a reason
 * (`HandoffStopped`). Returns the id that holds the claim.
 */
async function claimOnce(
  subAccountId: string,
  field: "contactFormId" | "workflowId",
  candidate: string,
  stale: string | null,
  guard?: (tx: FirebaseFirestore.Transaction) => Promise<string | null>,
): Promise<string> {
  const db = getAdminDb();
  const ref = db.doc(websiteHandoffStatePath(subAccountId));
  return db.runTransaction(async (tx) => {
    const refused = guard ? await guard(tx) : null;
    if (refused) throw new HandoffStopped(refused);
    const held = (await tx.get(ref)).data()?.[field] as unknown;
    if (typeof held === "string" && held && held !== stale) return held;
    tx.set(ref, { [field]: candidate, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return candidate;
  });
}

async function readClaim(
  subAccountId: string,
  field: "contactFormId" | "workflowId",
): Promise<string | null> {
  const held = (await getAdminDb().doc(websiteHandoffStatePath(subAccountId)).get()).data()?.[field] as unknown;
  return isDocId(held) ? held : null;
}

export interface HandoffInput {
  subAccountId: string;
  siteId: string;
  site: WebsiteDoc;
  config: WebsiteConfig;
  liveUrl: string;
  /** Whether `resolveLiveUrl` landed on a site. False: `liveUrl` is gitpage's
   *  reported address, unresolved, and its host is not allow-listed. */
  liveUrlResolved: boolean;
  result: PollBuildResult;
}

/**
 * The hostname to allow-list for a site address, or null. Only from a URL
 * that passes `safePagesUrl` (https, no credentials, not localhost or a
 * non-public IP literal), and only a plain DNS name — no IP literal of any
 * kind, and a top-level label that is not all digits: the allowlist is
 * compared against the Origin header of whoever loads the widget.
 */
function safeHostnameOf(url: string | null | undefined): string | null {
  const safe = safePagesUrl(url);
  if (!safe) return null;
  const host = new URL(safe).hostname.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".") || isIP(host)) return null;
  return /^\d+$/.test(host.slice(host.lastIndexOf(".") + 1)) ? null : host;
}

/**
 * Why the hand-off must stop writing, or null while it may go on: the site
 * is still there, still `ready` for the job that was settled, and the
 * workspace's website gate is still on. Read in the caller's transaction, so
 * a write made after it cannot land on a site that was removed, rebuilt or
 * switched off in the meantime.
 */
async function handoffBlocked(
  tx: FirebaseFirestore.Transaction,
  subAccountId: string,
  siteId: string,
  jobId: string | null,
): Promise<string | null> {
  const db = getAdminDb();
  const siteSnap = await tx.get(db.doc(`subAccounts/${subAccountId}/website/${siteId}`));
  const subSnap = await tx.get(db.doc(`subAccounts/${subAccountId}`));
  if (!siteSnap.exists) return "the site was removed";
  const fresh = siteSnap.data() as WebsiteDoc;
  if (!jobId || (fresh.gitpageJobId ?? null) !== jobId) return "the site was rebuilt";
  if (fresh.status !== "ready") return "the site is no longer live";
  if (subSnap.data()?.websiteEnabledByAgency !== true) {
    return "the website builder was switched off for this workspace";
  }
  return null;
}

/**
 * Multi-line text from gitpage (the knowledge base, the persona prompt):
 * control characters other than newline and tab are removed, the ends are
 * trimmed and the result is cut to `max`. Null when nothing is left.
 */
function cleanBlock(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/**
 * gitpage's accent as a stored colour, or null: #RRGGBB only, lower-cased —
 * the widget puts this value in a style attribute. Same test as the AI
 * Agents channel route applies to an operator's own pick.
 */
function hexColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find or create the sub-account's "Website contact" form. One per
 * sub-account (reused across sites and rebuilds) so submissions land in a
 * single place and the speed-to-lead workflow has one anchor.
 */
export async function ensureWebsiteContactForm(input: {
  subAccountId: string;
  createdByUid: string;
  /** A form id already on the site doc — reused if it still exists. */
  existingFormId?: string | null;
}): Promise<string> {
  const db = getAdminDb();
  const owned = async (formId: string): Promise<boolean> => {
    if (!isDocId(formId)) return false;
    const snap = await db.doc(`forms/${formId}`).get();
    return snap.exists && snap.data()?.subAccountId === input.subAccountId;
  };
  if (input.existingFormId && (await owned(input.existingFormId))) {
    return input.existingFormId;
  }
  const claimed = await readClaim(input.subAccountId, "contactFormId");
  if (claimed && (await owned(claimed))) return claimed;

  const existing = await db
    .collection("forms")
    .where("subAccountId", "==", input.subAccountId)
    .where("name", "==", WEBSITE_FORM_NAME)
    .limit(1)
    .get();
  let candidate = existing.empty ? null : existing.docs[0].id;
  const created = candidate === null;
  if (candidate === null) {
    // Lazy import keeps the forms service out of the client-side graph.
    const { createFormServerSide } = await import("@/lib/server/forms-service");
    candidate = await createFormServerSide({
      subAccountId: input.subAccountId,
      createdByUid: input.createdByUid,
      name: WEBSITE_FORM_NAME,
      template: "contact",
    });
  }
  const formId = await claimOnce(input.subAccountId, "contactFormId", candidate, claimed);
  // Another build claimed its form first: one form per sub-account.
  if (created && formId !== candidate) await db.doc(`forms/${candidate}`).delete();
  return formId;
}

/** Hosts that are never a published site — git hosts' own pages and the
 *  GitLab Pages access-control login (projects.gitlab.io/auth). */
const NON_SITE_HOSTS = new Set([
  "gitlab.com",
  "www.gitlab.com",
  "projects.gitlab.io",
  "github.com",
  "www.github.com",
]);

/** False for a URL that is clearly a login/auth page rather than the site. */
export function isPlausibleSiteUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (NON_SITE_HOSTS.has(u.hostname.toLowerCase())) return false;
    return !/^\/users\/sign_in\b/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Requests the walk below may make for one URL (so at most four redirects). */
const MAX_REDIRECT_HOPS = 5;
const RESOLVE_TIMEOUT_MS = 3000;
/** A redirect answer is headers; nothing here needs a body. */
const PROBE_MAX_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Pages hosts where every project gets its own subdomain of one shared
 *  parent, and the reported path URL redirects to it. */
const PAGES_PARENTS = ["gitlab.io", "github.io"];

const bareHost = (host: string) => host.toLowerCase().replace(/\.$/, "");

/** The Pages parent a host sits under (`acme.gitlab.io` → `gitlab.io`), or null. */
function pagesParentOf(host: string): string | null {
  const h = bareHost(host);
  return PAGES_PARENTS.find((p) => h === p || h.endsWith(`.${p}`)) ?? null;
}

/**
 * The hosts a reported site address may redirect to. A GitLab/GitHub Pages
 * report may land anywhere under its Pages parent (`*.gitlab.io` — where the
 * project's unique domain lives). Any other host: itself, its subdomains, and
 * its www/apex twin, decided on the registrable domain from the Public Suffix
 * List, so `acme.co.za` never reaches `evil.co.za`. A trailing dot is
 * stripped from both first, so `acme.com.` does not widen to all of `.com`.
 */
function inReportedFamily(reportedHost: string, host: string): boolean {
  const reported = bareHost(reportedHost);
  const landing = bareHost(host);
  if (landing === reported) return true;
  const parent = pagesParentOf(reported);
  if (parent) return landing.endsWith(`.${parent}`);
  // A reported host that is itself a public suffix (`co.za`, `netlify.app`)
  // has no family: its "subdomains" are everyone's sites.
  const apex = registrableDomain(reported);
  if (!apex) return false;
  if (landing.endsWith(`.${reported}`)) return true;
  return (reported === apex && landing === `www.${apex}`) || (reported === `www.${apex}` && landing === apex);
}

/**
 * The live address to store for a just-published site: the reported Pages
 * URL with redirects resolved (path URL → unique domain), but ONLY when the
 * redirect lands on a real site. gitpage reports GitLab's path URL
 * (user.gitlab.io/repo), which 308s to the project's unique domain — the
 * hostname visitors actually load, and so the one the chat allowlist must
 * contain. GitLab Pages access control can also briefly redirect a fresh
 * project to its login (→ gitlab.com/users/sign_in); that once became a
 * site's "live URL", Visit link and chat allowlist host upstream
 * (2026-10-04). On a non-site landing, keep the reported URL.
 *
 * The URL is gitpage's, not ours, so nothing here follows a redirect on its
 * own (upstream uses `fetch` with `redirect: "follow"`). Each hop is one
 * `publicFetch` — which in production connects only to public addresses and
 * never follows a redirect — and each `Location` is resolved against the hop
 * it came from and must itself be a plain public https site address, on the
 * reported host or a host under its parent domain (`inReportedFamily`),
 * before it is requested. HEAD, not upstream's GET: only the status and
 * `Location` are read, and a landing page larger than the body cap would
 * otherwise count as a failure.
 *
 * Never throws. ONE 3 s deadline covers every hop. `resolved` is true only
 * when the walk landed on an answer that is not a redirect; on the hop cap, a
 * redirect with no `Location`, a hop that is refused, or any error, the
 * reported URL comes back with `resolved: false`.
 */
export async function resolveLiveUrl(
  pagesUrl: string,
): Promise<{ url: string; resolved: boolean }> {
  const unresolved = { url: pagesUrl, resolved: false };
  if (!isPlausibleSiteUrl(pagesUrl)) {
    console.warn(`[website] gitpage reported a non-site live URL: ${pagesUrl}`);
    return unresolved;
  }
  try {
    const reportedHost = new URL(pagesUrl).hostname.toLowerCase();
    const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    let current = pagesUrl;
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
      const res = await publicFetch(current, { method: "HEAD", signal, maxBytes: PROBE_MAX_BYTES });
      if (!REDIRECT_STATUSES.has(res.status)) return { url: current, resolved: true };
      const location = res.headers.get("location");
      if (!location) return unresolved;
      const next = safePagesUrl(new URL(location, current).href);
      if (!next || !isPlausibleSiteUrl(next)) return unresolved;
      if (!inReportedFamily(reportedHost, new URL(next).hostname.toLowerCase())) return unresolved;
      current = next;
    }
    return unresolved;
  } catch {
    return unresolved;
  }
}

/** The LeadStack endpoints baked into a premium site. Null when the app URL isn't public https. */
export function leadstackWiringFor(input: {
  subAccountId: string;
  formId: string | null;
  config: WebsiteConfig;
  /** Pass the result of `resolvedAppUrl()` so no baked URL ever redirects. */
  appUrl?: string | null;
}): {
  appUrl: string;
  subAccountId: string;
  formId?: string;
  formSubmitUrl?: string;
  widgetScriptUrl?: string;
} | null {
  const appUrl = (input.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return null;
  return {
    appUrl,
    subAccountId: input.subAccountId,
    ...(wantsLeadForm(input.config) && input.formId
      ? { formId: input.formId, formSubmitUrl: `${appUrl}/api/forms/${input.formId}/submit` }
      : {}),
    ...(wantsChatWidget(input.config) ? { widgetScriptUrl: `${appUrl}/widget.js` } : {}),
  };
}

/** The absolute `build.settled` callback URL, or null when not publicly reachable. */
export function buildSettledCallbackUrl(resolved?: string | null): string | null {
  const appUrl = (resolved ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+$/i.test(appUrl)) return null;
  return `${appUrl}/api/webhooks/gitpage/build-settled`;
}

/** A hand-off summary with nothing done yet — also what a hand-off that threw records. */
export function blankProvisioning(formId: string | null, errors: string[] = []): WebsiteProvisioning {
  return {
    at: FieldValue.serverTimestamp(),
    hostname: null,
    formId,
    chatAllowlisted: false,
    chatEnabled: false,
    chatSkippedReason: null,
    voiceEnabled: false,
    voiceSkippedReason: "Web Voice hand-off did not run.",
    kbSeeded: false,
    personaSeeded: false,
    workflowId: null,
    workflowStatus: null,
    workflowChannels: [],
    errors,
  };
}

// ---------------------------------------------------------------------------
// The hand-off

/** Null when the agency's website gate is off for the workspace: nothing ran. */
export async function provisionWebsiteHandoff(
  input: HandoffInput,
): Promise<WebsiteProvisioning | null> {
  const { subAccountId, siteId, site, config, liveUrl, liveUrlResolved, result } = input;
  const db = getAdminDb();
  const jobId = site.gitpageJobId ?? null;

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = (subSnap.data() ?? {}) as SubAccountDoc;
  // The gate as it is NOW, not as it was when the build was accepted. Fails
  // closed: a missing sub-account or a missing field is "off". Every write
  // below re-checks it, with the site, in its own transaction.
  if (sub.websiteEnabledByAgency !== true) return null;
  const agencyId = (sub.agencyId as string | undefined) ?? site.agencyId;
  const blocked = (tx: FirebaseFirestore.Transaction) => handoffBlocked(tx, subAccountId, siteId, jobId);

  const errors: string[] = [];
  // Only the host visitors load is allow-listed — never gitpage's reported
  // path-URL host: GitLab serves every project of a namespace from that one
  // origin (namespace.gitlab.io/<project>), other tenants' sites included.
  // So it is the host the walk landed on, and never the reported host when
  // that host is shared: a report under a path, or a Pages host reported
  // as-is (the namespace root, or a redirect back to it). A different host
  // the walk landed on is the site's own, whatever path it ended on.
  const candidateHost = safeHostnameOf(liveUrl);
  let reported: URL | null = null;
  try {
    reported = new URL(result.pagesUrl ?? "");
  } catch {
    reported = null;
  }
  const reportedHost = reported ? bareHost(reported.hostname) : null;
  const reportedUnderPath = !!reported && reported.pathname.replace(/\/+$/, "") !== "";
  let allowlistRefusal: string | null = null;
  if (!candidateHost) {
    errors.push("live URL: not a public https address — its host was not added to the chat allowlist");
  } else if (!liveUrlResolved) {
    allowlistRefusal = `gitpage's address (${liveUrl}) did not lead to the site's own host, so nothing was added to the chat allowlist — add the site's domain in AI Agents → Web Chat.`;
  } else if (
    candidateHost === reportedHost &&
    (reportedUnderPath || pagesParentOf(reportedHost) || !registrableDomain(reportedHost))
  ) {
    allowlistRefusal = `The site is served from gitpage's address on a host other sites share (${liveUrl}), so it was not added to the chat allowlist — add the site's own domain in AI Agents → Web Chat.`;
  }
  const hostname = allowlistRefusal ? null : candidateHost;
  // Seeded as the bot's website only when its host is one we allow-list.
  const safeLiveUrl = hostname ? safePagesUrl(liveUrl) : null;
  const premium = result.premium;

  const out = blankProvisioning(site.formId ?? null, errors);
  out.hostname = hostname;
  /** The site moved on (or the gate went off): record why, run nothing more. */
  const stop = (reason: string) => {
    errors.push(`hand-off stopped: ${reason}`);
    return out;
  };

  // Auto-filled values follow the LATEST published site until the operator
  // edits them. A value counts as "auto" when it's blank / the stock default,
  // or still equals what the hand-off seeded last time. Profiles seeded
  // before this tracking existed (KB from a build, no record) are treated as
  // auto too. The operator's own wording is never overwritten.
  const autoTest = (profile: Partial<AiAgentProfile> | null) => {
    const seeded = profile?.websiteSeeded ?? null;
    const legacyAuto = !seeded && profile?.websiteKbSource === "gitpage-build";
    return (current: string | null | undefined, seededValue: string | null | undefined, stock?: string) =>
      !current?.trim() || (stock !== undefined && current === stock) || (!!seededValue && current === seededValue) || legacyAuto;
  };
  type ChatSeeded = NonNullable<AiChannelConfig["websiteSeeded"]>;

  // Bind a later enable to the ready connection approved before any hand-off
  // writes. A replacement after this snapshot is a different operator decision.
  let approvedVoice: WebVoiceHandoffSnapshot | null = null;
  let voiceApprovalFailed = false;
  if (wantsWebVoice(config)) {
    try {
      approvedVoice = await readWebVoiceHandoffSnapshot(subAccountId);
    } catch {
      voiceApprovalFailed = true;
      errors.push("web-voice: the ready connection could not be verified");
    }
  }

  // 1. Chat: allowlist the hostname. The bot is NOT switched on here. The
  // cap check and the append are one transaction, so two sites publishing
  // at once cannot take the list past the cap.
  if (wantsChatWidget(config)) {
    try {
      const welcome = cleanText(premium?.agentPersona?.welcomeMessage, WELCOME_MAX_CHARS);
      const accent = hexColor(premium?.theme?.primaryColor);
      type ChatStep =
        | { refused: string }
        | { refused: null; full: boolean; allowlisted: boolean; enabled: boolean };
      const chat = await transactAiAgentDoc<ChatStep>(subAccountId, "web-chat", async (tx, existing) => {
        const refused = await blocked(tx);
        if (refused) return { patch: null, result: { refused } };
        const existingChat = (existing?.webChat ?? null) as Partial<typeof DEFAULT_WEB_CHAT_CONFIG> | null;
        const current = { ...DEFAULT_WEB_CHAT_CONFIG, ...(existingChat ?? {}) };
        const have = new Set(current.allowedDomains.map((d) => d.toLowerCase()));
        // A channel doc that does not exist yet gets the stock widget block;
        // an existing one is merged into, field by field.
        const webChat: Record<string, unknown> = existingChat ? {} : { ...DEFAULT_WEB_CHAT_CONFIG };
        const adding = !!hostname && !have.has(hostname);
        const full = adding && current.allowedDomains.length >= MAX_ALLOWED_DOMAINS;
        if (adding && !full) webChat.allowedDomains = [...current.allowedDomains, hostname];
        // What the hand-off filled in last time is recorded on this doc and
        // read and written in this same transaction, so the record can
        // never disagree with the values it describes.
        const seededNow = (existing?.websiteSeeded ?? null) as ChatSeeded | null;
        const isAuto = (value: string, seededValue: string | null | undefined, stock: string) =>
          !value.trim() || value === stock || (!!seededValue && value === seededValue);
        const seeded: ChatSeeded = {};
        if (welcome && isAuto(current.welcomeMessage, seededNow?.welcomeMessage, DEFAULT_WEB_CHAT_CONFIG.welcomeMessage)) {
          webChat.welcomeMessage = welcome;
          seeded.welcomeMessage = welcome;
        }
        if (accent && isAuto(current.accentColor, seededNow?.accentColor, DEFAULT_WEB_CHAT_CONFIG.accentColor)) {
          webChat.accentColor = accent;
          seeded.accentColor = accent;
        }
        const patch: Record<string, unknown> = {};
        if (Object.keys(webChat).length > 0) patch.webChat = webChat;
        if (Object.keys(seeded).length > 0) patch.websiteSeeded = { ...(seededNow ?? {}), ...seeded };
        return {
          patch: Object.keys(patch).length > 0 ? patch : null,
          result: {
            refused: null,
            full,
            allowlisted: !!hostname && (have.has(hostname) || (adding && !full)),
            enabled: existing?.enabled === true,
          },
        };
      });
      if (chat.refused !== null) return stop(chat.refused);
      if (chat.full) {
        errors.push(`web-chat: the allowed-domains list is full (${MAX_ALLOWED_DOMAINS}) — add ${hostname} by hand`);
      }
      out.chatAllowlisted = chat.allowlisted;
      // Upstream switches the channel on here. Nothing automated starts
      // talking to visitors: the bot stays as the operator left it, and the
      // card says why it is off (or why the widget will not load at all).
      out.chatEnabled = chat.enabled;
      if (allowlistRefusal) {
        out.chatSkippedReason = allowlistRefusal;
      } else if (!out.chatEnabled) {
        out.chatSkippedReason = !aiIsConfigured()
          ? "OPENROUTER_API_KEY is not set on this deployment — the widget is on the site but the bot stays off until a key is added and Web Chat is enabled."
          : !aiChannelGateOn(sub, "web-chat")
            ? "The agency has locked Web Chat AI for this workspace."
            : "Web Chat AI is switched off for this workspace — the widget is on the site; turn the bot on in AI Agents when you are ready.";
      }
    } catch (err) {
      errors.push(`web-chat: ${errText(err)}`);
    }
  } else {
    out.chatSkippedReason = "Chat widget not included in this build.";
  }

  // 1b. Web Voice is workspace-wide, so this branch may only turn it on.
  // It never writes `enabled: false`, including when this build opts out.
  const voiceTransactionGuard = async (tx: FirebaseFirestore.Transaction) => {
    const refused = await blocked(tx);
    if (refused) throw new HandoffStopped(refused);
    const freshSub = (await tx.get(db.doc(`subAccounts/${subAccountId}`))).data() as SubAccountDoc;
    if (freshSub.webVoiceEnabledByAgency !== true) {
      throw new HandoffStopped("the agency switched off Web Voice for this workspace");
    }
    if (!aiChannelGateOn(freshSub, "web-chat")) {
      throw new HandoffStopped("the agency locked Web Chat AI for this workspace");
    }
    if (!aiIsConfigured()) {
      throw new HandoffStopped("the AI provider is no longer configured");
    }
    if (freshSub.webVoiceMeta?.ready !== true) {
      throw new HandoffStopped("the ElevenLabs connection was no longer ready");
    }
    const chat = await tx.get(db.doc(`subAccounts/${subAccountId}/aiAgent/web-chat`));
    if (chat.data()?.enabled !== true) {
      throw new HandoffStopped("Web Chat AI was switched off for this workspace");
    }
  };
  if (!wantsWebVoice(config)) {
    out.voiceSkippedReason = wantsChatWidget(config)
      ? "Web Voice was not included in this build; the workspace setting was left unchanged."
      : "Web Voice needs the chat widget; the workspace setting was left unchanged.";
  } else if (sub.webVoiceEnabledByAgency !== true) {
    out.voiceSkippedReason = "The agency has not enabled Web Voice for this workspace.";
  } else if (!aiChannelGateOn(sub, "web-chat")) {
    out.voiceSkippedReason = "The agency has locked Web Chat AI for this workspace.";
  } else if (!aiIsConfigured()) {
    out.voiceSkippedReason = "OPENROUTER_API_KEY is not set on this deployment, so Web Voice was not enabled.";
  } else if (voiceApprovalFailed) {
    out.voiceSkippedReason = "The ready ElevenLabs connection could not be verified; Web Voice was not enabled.";
  } else if (approvedVoice?.ready !== true) {
    out.voiceSkippedReason = "Connect and finish setting up ElevenLabs in AI Agents → Web Chat → Voice.";
  } else if (!out.chatEnabled) {
    out.voiceSkippedReason = "Web Chat AI is switched off; turn it on before enabling voice.";
  } else if (!approvedVoice.revision) {
    out.voiceSkippedReason = "The ready ElevenLabs connection changed or could not be verified; Web Voice was not enabled.";
  } else if (approvedVoice.enabled) {
    try {
      await validateWebVoiceHandoff({
        subAccountId,
        expectedRevision: approvedVoice.revision,
        transactionGuard: voiceTransactionGuard,
      });
      out.voiceEnabled = true;
      out.voiceSkippedReason = null;
    } catch (err) {
      out.voiceSkippedReason = err instanceof HandoffStopped
        ? `Web Voice was not confirmed: ${err.message}.`
        : "Web Voice was not confirmed because its connection changed or could not be verified.";
    }
  } else {
    try {
      const meta = await updateWebVoiceSettings({
        subAccountId,
        patch: { enabled: true },
        expectedRevision: approvedVoice.revision,
        transactionGuard: voiceTransactionGuard,
      });
      out.voiceEnabled = meta.ready === true && meta.enabled !== false;
      out.voiceSkippedReason = out.voiceEnabled
        ? null
        : "ElevenLabs could not enable Web Voice; check the Voice settings card.";
    } catch (err) {
      if (err instanceof HandoffStopped) {
        out.voiceSkippedReason = `Web Voice was not enabled: ${err.message}.`;
      } else {
        errors.push("web-voice: Web Voice could not be enabled; check the Voice settings card");
        out.voiceSkippedReason = "Web Voice could not be enabled; check the Voice settings card.";
      }
    }
  }

  // 2. KB + persona (one write, decided on the profile as it is now).
  try {
    const persona = premium?.agentPersona ?? null;
    const kb = cleanBlock(premium?.kbText, KB_MAX_CHARS);
    const systemPrompt = persona ? cleanBlock(persona.systemPrompt, PROMPT_MAX_CHARS) : null;
    const businessName = persona ? cleanText(persona.businessName, BUSINESS_NAME_MAX_CHARS) : null;
    const keywords = (Array.isArray(persona?.escalationKeywords) ? persona.escalationKeywords : [])
      .map((k) => cleanText(k, KEYWORD_MAX_CHARS))
      .filter((k): k is string => k !== null)
      .slice(0, MAX_ESCALATION_KEYWORDS);
    type ProfileStep = { refused: string } | { refused: null; personaSeeded: boolean };
    const profile = await transactAiAgentDoc<ProfileStep>(subAccountId, "profile", async (tx, current) => {
      const refused = await blocked(tx);
      if (refused) return { patch: null, result: { refused } };
      const now = current as Partial<AiAgentProfile> | null;
      const isAuto = autoTest(now);
      const seededNow = now?.websiteSeeded ?? null;
      const seededNext: NonNullable<AiAgentProfile["websiteSeeded"]> = { ...(seededNow ?? {}) };
      const patch: Partial<AiAgentProfile> = {};
      if (safeLiveUrl && isAuto(now?.websiteUrl, seededNow?.websiteUrl)) {
        patch.websiteUrl = safeLiveUrl;
        seededNext.websiteUrl = safeLiveUrl;
      }
      if (kb) {
        patch.websiteKb = kb;
        patch.websiteKbFetchedAt = FieldValue.serverTimestamp();
        patch.websiteKbSource = "gitpage-build";
        patch.websiteKbSiteId = siteId;
      }
      let personaSeeded = false;
      if (systemPrompt && isAuto(now?.systemPrompt, seededNow?.systemPrompt)) {
        patch.systemPrompt = systemPrompt;
        seededNext.systemPrompt = systemPrompt;
        personaSeeded = true;
      }
      if (businessName && isAuto(now?.businessName, seededNow?.businessName)) {
        patch.businessName = businessName;
        seededNext.businessName = businessName;
      }
      if (!now && keywords.length) patch.escalationKeywords = keywords;
      if (!now?.escalationNotifyEmail?.trim()) {
        const email = (config.contact_details ?? "").trim() || sub.accountContact?.email?.trim() || "";
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) patch.escalationNotifyEmail = email;
      }
      patch.websiteSeeded = seededNext;
      return { patch: patch as Record<string, unknown>, result: { refused: null, personaSeeded } };
    });
    if (profile.refused !== null) return stop(profile.refused);
    out.kbSeeded = !!kb;
    out.personaSeeded = profile.personaSeeded;
  } catch (err) {
    errors.push(`agent profile: ${errText(err)}`);
  }

  // 3. Speed-to-lead workflow pinned to the site's form. A DRAFT, always.
  if (wantsLeadForm(config) && site.formId) {
    try {
      const formId = site.formId;
      const ours = (wf: WorkflowDoc | undefined): wf is WorkflowDoc =>
        !!wf && wf.subAccountId === subAccountId && wf.trigger?.formId === formId;
      const report = (id: string, wf: WorkflowDoc) => {
        out.workflowId = id;
        out.workflowStatus = wf.status === "active" ? "active" : "draft";
        out.workflowChannels = Object.values(wf.nodes ?? {}).map((n) => n.type);
      };

      const claimed = await readClaim(subAccountId, "workflowId");
      const claimedWf = claimed
        ? ((await db.doc(`workflows/${claimed}`).get()).data() as WorkflowDoc | undefined)
        : undefined;
      if (claimed && ours(claimedWf)) {
        report(claimed, claimedWf);
      } else {
        // Cheap early no before anything is created; the claim below
        // re-checks atomically and deletes what this call made if refused.
        const refused = await db.runTransaction((tx) => blocked(tx));
        if (refused) return stop(refused);
        const already = await db
          .collection("workflows")
          .where("subAccountId", "==", subAccountId)
          .where("provisionedFrom", "==", WEBSITE_WORKFLOW_SOURCE)
          .get();
        const match = already.docs.find(
          (d) => (d.data() as WorkflowDoc).trigger?.formId === formId,
        );
        let candidate = match?.id ?? null;
        const created = candidate === null;
        if (candidate === null) {
          const agencySnap = agencyId ? await db.doc(`agencies/${agencyId}`).get() : null;
          const agency = (agencySnap?.data() ?? {}) as AgencyDoc;
          const sharedSmsAllowed = agency.sharedSmsAllowed !== false;
          const smsReady =
            subAccountTwilioIsConfigured(sub.twilioConfig) ||
            (sharedSmsAllowed && smsIsConfigured());
          // The sub-account doc decides: its own SMTP, else the Resend env.
          const emailReady = emailIsConfigured(sub);

          // Created as a draft, and left one: `status` is never written.
          candidate = await createWorkflowServerSide({
            subAccountId,
            createdByUid: site.lastBuildByUid ?? "system",
            name: "Website speed-to-lead",
            template: "speed-to-lead",
            formId,
          });
          const seeded = (await db.doc(`workflows/${candidate}`).get()).data() as WorkflowDoc;
          const kept: WorkflowNode[] = [];
          for (const id of ["n1", "n2", "n3"]) {
            const node = seeded.nodes[id];
            if (!node) continue;
            if (node.type === "send_sms" && !smsReady) continue;
            if (node.type === "send_email" && !emailReady) continue;
            kept.push({ ...node });
          }
          // Re-link the surviving chain in order.
          const nodes: Record<string, WorkflowNode> = {};
          kept.forEach((node, i) => {
            nodes[node.id] = { ...node, next: kept[i + 1]?.id ?? null };
          });
          const notify = nodes.n3;
          if (notify) {
            notify.config = {
              ...notify.config,
              recipient: sub.accountContact?.email?.trim() ? "account_contact" : "owner",
              subject: `New lead from ${config.heading || "your website"}`,
              body: "{{contact.name}} ({{contact.email}} · {{contact.phone}}) just submitted the website contact form.",
            };
          }
          await db.doc(`workflows/${candidate}`).update({
            ...workflowPatchWrite({ nodes, startNodeId: kept[0]?.id ?? null }),
            provisionedFrom: WEBSITE_WORKFLOW_SOURCE,
            provisionedSiteId: siteId,
          });
        }
        let workflowId: string;
        try {
          workflowId = await claimOnce(subAccountId, "workflowId", candidate, claimed, blocked);
        } catch (err) {
          if (!(err instanceof HandoffStopped)) throw err;
          if (created) await deleteWorkflowServerSide(subAccountId, candidate);
          return stop(err.message);
        }
        // Another site's hand-off claimed its workflow first: one per workspace.
        if (created && workflowId !== candidate) {
          await deleteWorkflowServerSide(subAccountId, candidate);
        }
        const wf = (await db.doc(`workflows/${workflowId}`).get()).data() as WorkflowDoc | undefined;
        if (!wf || wf.subAccountId !== subAccountId) {
          throw new Error("the provisioned workflow could not be read back");
        }
        report(workflowId, wf);
      }
    } catch (err) {
      errors.push(`speed-to-lead: ${errText(err)}`);
    }
  }

  // 4. Push the team — only about a site that is still live.
  if (agencyId) {
    try {
      const refused = await db.runTransaction((tx) => blocked(tx));
      if (refused) return stop(refused);
      await sendPushForEvent({
        subAccountId,
        agencyId,
        title: "Website published",
        body: `${site.name || config.heading || "Your site"} is live at ${hostname ?? liveUrl}.`,
        url: `/sa/${subAccountId}/website`,
        tag: `website-${siteId}`,
      });
    } catch (err) {
      errors.push(`push: ${errText(err)}`);
    }
  }

  return out;
}
