import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { MAX_WEBSITES_PER_SUBACCOUNT } from "@/lib/website/limits";
import {
  validateWebsiteConfig,
  type ValidationErrors,
} from "@/lib/website/validation";
import { isNicheKey } from "@/lib/website/niches";
import {
  GitpageError,
  gitpageIsConfigured,
  safePagesUrl,
  submitBuild,
  type PollBuildResult,
} from "@/lib/gitpage/client";
import {
  markGitpageBuildSucceeded,
  markGitpageKeyInvalid,
} from "@/lib/gitpage/heartbeat";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import { runAfterResponse } from "@/lib/server/after-response";
import { resolvedAppUrl } from "@/lib/server/app-url";
import { isDocId } from "@/lib/server/doc-id";
import { oneLine } from "@/lib/ai-suite/capabilities/text-safety";
import {
  blankProvisioning,
  buildSettledCallbackUrl,
  ensureWebsiteContactForm,
  leadstackWiringFor,
  provisionWebsiteHandoff,
  resolveLiveUrl,
  type HandoffInput,
} from "@/lib/server/website-handoff-service";
import {
  blankWebsiteConfig,
  effectiveQuality,
  wantsLeadForm,
  type WebsiteConfig,
  type WebsiteDoc,
  type WebsiteProvisioning,
  type WebsiteStatus,
} from "@/types/website";

/** First poll delay + cadence (seconds). Premium builds back off after 5 min. */
export const WEBSITE_POLL_INTERVAL_SECONDS = 20;
export const WEBSITE_POLL_BACKOFF_SECONDS = 40;
/** Floor/ceiling on the poll cap derived from gitpage's duration estimate. */
export const WEBSITE_MIN_POLL_ATTEMPTS = 45;
export const WEBSITE_MAX_POLL_ATTEMPTS = 120;

/**
 * How many poll ticks a job gets before we give up. gitpage reports an
 * `estimatedDurationSeconds` on accept (300 for standard, 1200 for premium);
 * the cap is 1.5× that at the base cadence, clamped to [45, 120] ticks. The
 * wall clock those ticks span is longer than ticks × 20s, because the
 * cadence backs off (`pollDelayFor`): `pollWindowSecondsFor` computes it —
 * about 55 minutes for a premium build's 90 ticks, about 25 for the 45-tick
 * floor.
 */
export function pollAttemptCapFor(estimatedDurationSeconds: number | null | undefined): number {
  const est = typeof estimatedDurationSeconds === "number" && estimatedDurationSeconds > 0
    ? estimatedDurationSeconds
    : 300;
  const ticks = Math.ceil((est * 1.5) / WEBSITE_POLL_INTERVAL_SECONDS);
  return Math.min(WEBSITE_MAX_POLL_ATTEMPTS, Math.max(WEBSITE_MIN_POLL_ATTEMPTS, ticks));
}

/** Poll delay for the NEXT tick: 20s for the first 5 minutes, then 40s. */
export function pollDelayFor(attempts: number): number {
  return attempts >= 15 ? WEBSITE_POLL_BACKOFF_SECONDS : WEBSITE_POLL_INTERVAL_SECONDS;
}

/**
 * Wall-clock seconds from a build's submit to the tick that gives up on it:
 * the first poll's delay, then the delay after each tick up to the cap (the
 * tick after the cap is the one that times the build out). The one place
 * the poll window's length is worked out — the timeout message and the docs
 * quote this, not a number of their own.
 */
export function pollWindowSecondsFor(estimatedDurationSeconds: number | null | undefined): number {
  const cap = pollAttemptCapFor(estimatedDurationSeconds);
  let seconds = WEBSITE_POLL_INTERVAL_SECONDS;
  for (let attempts = 1; attempts <= cap; attempts++) seconds += pollDelayFor(attempts);
  return seconds;
}

/**
 * How long a site may sit in flight without a write before its poll chain
 * is taken to be dead: two of the chain's own intervals. A live chain
 * writes the doc on every tick, at most `pollDelayFor` apart.
 */
export function pollChainStaleAfterMs(attempts: number): number {
  return 2 * pollDelayFor(attempts) * 1000;
}

/**
 * Build submits one sub-account may send to gitpage per hour. Each premium
 * build spends the agency's model and image budget on gitpage's side, and
 * gitpage's own cap (30 an hour) is per AGENCY, so without this one
 * workspace could use up every other workspace's builds. Ten covers five
 * sites built and rebuilt once.
 */
export const WEBSITE_BUILDS_PER_HOUR = 10;
const BUILD_WINDOW_MS = 60 * 60 * 1000;

/**
 * `subAccounts/{id}/private/websiteLimits` — Admin SDK only, under the
 * generic `private/{docId}` deny rule. Two jobs, both needing one doc every
 * writer for the sub-account contends on:
 *   `windowStart` (ms) + `count`  the hourly build counter, reserved in a
 *                                 transaction BEFORE gitpage is called, so
 *                                 it holds across instances and under
 *                                 concurrency (an in-memory limiter is per
 *                                 process and resets on a restart);
 *   `createSeq`                   bumped by every transaction that creates a
 *                                 site doc, which makes two creations
 *                                 conflict and so makes the site-count cap
 *                                 atomic (a count query alone gives no
 *                                 protection against a concurrent insert).
 */
export const websiteLimitsPath = (subAccountId: string) =>
  `subAccounts/${subAccountId}/private/websiteLimits`;

/**
 * A transaction that gave up after its retries because other transactions
 * kept winning the same doc (gRPC ABORTED). On the limits doc that means
 * many submits or creates for one sub-account at the same instant; the
 * callers below answer it as "busy, try again" rather than a bare 500.
 */
function isContention(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 10;
}
const BUSY_RETRY_AFTER_SEC = 5;

/**
 * Take one of the sub-account's hourly build submits, or say when the next
 * is free. A fixed window: the first submit opens it, the hour after that
 * closes it. A reservation is consumed whatever happens after it is taken:
 * gitpage accepting, gitpage answering 4xx or 5xx, or the request throwing.
 * There is deliberately no way to give one back — un-counting on failure is
 * how a bound leaks, and a throw cannot be told from "sent, answer lost".
 * The cost: ten failed attempts in the hour, including during a gitpage
 * outage, lock builds for the workspace until the window rolls.
 * Fails closed: a reservation that cannot be made (contention) is a refusal.
 */
async function reserveBuildSubmit(
  subAccountId: string,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number; busy?: true }> {
  const db = getAdminDb();
  const ref = db.doc(websiteLimitsPath(subAccountId));
  const reserve = () => db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data() as { windowStart?: unknown; count?: unknown } | undefined;
    const now = Date.now();
    // A window is open for an hour from its start. A start slightly in the
    // future is another instance's clock running ahead and is still this
    // window; one an hour or more away is not a window at all.
    const windowStart =
      typeof cur?.windowStart === "number" &&
      Number.isFinite(cur.windowStart) &&
      Math.abs(now - cur.windowStart) < BUILD_WINDOW_MS
        ? cur.windowStart
        : null;
    // Inside an open window a count that is not a whole number ≥ 0 is not
    // read as "none used": it is read as "all used" (fails closed).
    const stored = cur?.count;
    const count =
      windowStart === null
        ? 0
        : typeof stored === "number" && Number.isInteger(stored) && stored >= 0
          ? stored
          : WEBSITE_BUILDS_PER_HOUR;
    if (count >= WEBSITE_BUILDS_PER_HOUR) {
      const left = (windowStart ?? now) + BUILD_WINDOW_MS - now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(left / 1000)) } as const;
    }
    tx.set(
      ref,
      { windowStart: windowStart ?? now, count: count + 1, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { ok: true } as const;
  });
  try {
    return await reserve();
  } catch (err) {
    if (!isContention(err)) throw err;
    return { ok: false, retryAfterSec: BUSY_RETRY_AFTER_SEC, busy: true };
  }
}

/**
 * Whether the sub-account has room for one more site doc — read INSIDE the
 * caller's transaction, after it has read the limits doc, and followed by
 * `claimSiteSlot` when the caller goes on to create. Reading and then
 * writing the one limits doc is what serialises creators; the count that a
 * second creator sees on its re-run includes the first one's doc.
 */
async function siteSlotFree(
  tx: FirebaseFirestore.Transaction,
  subAccountId: string,
): Promise<{ free: boolean; count: number }> {
  const db = getAdminDb();
  await tx.get(db.doc(websiteLimitsPath(subAccountId)));
  const existing = await tx.get(db.collection(`subAccounts/${subAccountId}/website`));
  return { free: existing.size < MAX_WEBSITES_PER_SUBACCOUNT, count: existing.size };
}

function claimSiteSlot(tx: FirebaseFirestore.Transaction, subAccountId: string): void {
  tx.set(
    getAdminDb().doc(websiteLimitsPath(subAccountId)),
    { createSeq: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

const SITE_CAP_MESSAGE = `You can create up to ${MAX_WEBSITES_PER_SUBACCOUNT} websites per sub-account. Remove one to add another.`;

/** A build that gitpage has accepted and not yet reported as finished. */
export const WEBSITE_IN_FLIGHT: readonly WebsiteStatus[] = ["queued", "building"];

export interface WebsiteTransitionGuard {
  /** The statuses the doc may be in for the write to apply. */
  fromStatuses: readonly WebsiteStatus[];
  /**
   * The job the caller is acting for. When given, the doc must still carry
   * exactly this `gitpageJobId` (null = no job). Omit only for a write that
   * is not about a job (the draft save, a new submit).
   */
  expectJobId?: string | null;
  /** A further condition on the doc as the transaction reads it. */
  when?: (fresh: WebsiteDoc) => boolean;
  /**
   * Create the doc when it does not exist. Only for a writer that itself
   * read the doc as absent and means to create it: a doc that vanished
   * under a writer who read it (a Remove) must stay gone. The patch must
   * carry the tenancy keys, and the creation is held to the site cap.
   */
  orMissing?: boolean;
  /** Write with set-merge instead of update (the build submit, as before). */
  merge?: boolean;
  /**
   * More of the same transaction, run once the guard has passed and before
   * the site doc is written: for a write that must land together with one
   * on another doc (the custom domain and the Web Chat allow-list). Returns
   * fields to add to the patch, or false to apply nothing (reason
   * "condition"). All its reads come before its writes, and it writes only
   * when it returns fields. Not run for a doc this call creates.
   */
  inTransaction?: (
    tx: FirebaseFirestore.Transaction,
    fresh: WebsiteDoc,
  ) => Promise<Record<string, unknown> | false>;
}

export type WebsiteTransitionResult =
  | { applied: true }
  | { applied: false; reason: "missing" | "job" | "status" | "condition" | "cap" };

/**
 * The ONE way a website doc's build state is written.
 *
 * Five writers race on a site doc: the QStash poll tick, the manual
 * re-check, gitpage's callback, the operator's draft save, and a build
 * submit. Each reads the doc, does something slow (a call to
 * gitpage, a queue publish), then writes — and a plain `update` after that
 * gap writes over whatever landed in between: `building` over a site the
 * callback just made `ready`, a timeout from an old job over a new one.
 *
 * So every such write re-reads the doc inside a transaction and applies
 * only if the doc is still what the writer acted on: the same job, and a
 * status the writer is allowed to move it from. Anything else is a no-op
 * with the reason, and the caller stops (no reschedule, no hand-off).
 * The caller states the rule; this function is where it is enforced.
 */
export async function transitionWebsite(
  docRef: FirebaseFirestore.DocumentReference,
  guard: WebsiteTransitionGuard,
  patch: Record<string, unknown>,
): Promise<WebsiteTransitionResult> {
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      if (!guard.orMissing) return { applied: false, reason: "missing" } as const;
      // The cap is counted where the doc will be WRITTEN: the sub-account
      // comes from the doc's own path, never from the patch, and the path
      // must be exactly subAccounts/{id}/website/{siteId} — a site id that
      // is really a path ("x/y/z") would create a doc in a nested
      // collection that the count never sees.
      const at = /^subAccounts\/([^/]+)\/website\/[^/]+$/.exec(docRef.path);
      if (!at) {
        throw new Error(`transitionWebsite: refusing to create a site doc at ${docRef.path}`);
      }
      const subAccountId = at[1];
      // A doc this helper creates is a tenant doc like any other, stamped
      // with the sub-account it lives under.
      const { agencyId } = patch;
      if (typeof agencyId !== "string" || !agencyId || patch.subAccountId !== subAccountId) {
        throw new Error("transitionWebsite: refusing to create a site doc without agencyId and subAccountId");
      }
      if (!(await siteSlotFree(tx, subAccountId)).free) {
        return { applied: false, reason: "cap" } as const;
      }
      tx.set(docRef, patch, { merge: true });
      claimSiteSlot(tx, subAccountId);
      return { applied: true } as const;
    }
    const fresh = snap.data() as WebsiteDoc;
    if (guard.expectJobId !== undefined && (fresh.gitpageJobId ?? null) !== guard.expectJobId) {
      return { applied: false, reason: "job" } as const;
    }
    if (!guard.fromStatuses.includes(fresh.status)) {
      return { applied: false, reason: "status" } as const;
    }
    if (guard.when && !guard.when(fresh)) {
      return { applied: false, reason: "condition" } as const;
    }
    const more = guard.inTransaction ? await guard.inTransaction(tx, fresh) : {};
    if (more === false) return { applied: false, reason: "condition" } as const;
    const write = { ...patch, ...more };
    if (guard.merge) tx.set(docRef, write, { merge: true });
    else tx.update(docRef, write);
    return { applied: true } as const;
  });
}

/**
 * Whether a terminal result can be recorded. gitpage can report Published
 * a moment before it has the address; a site is not "ready" without one,
 * so Published with NO address is treated as still in flight and the poll
 * comes back. Published with an address that was refused is settleable —
 * as a failure that names it (`settleWebsiteBuild`): waiting would only run
 * the poll to its cap with nobody told why.
 */
export function isSettleable(result: PollBuildResult): boolean {
  if (!result.isTerminal) return false;
  return result.status !== "Published" || !!result.pagesUrl || !!result.pagesUrlRefused;
}

/**
 * Server-side website create + build — the single write path shared by the
 * website API routes (`POST /api/sub-accounts/[id]/website` and
 * `.../website/[siteId]/build`) and the AI Suite `create_website`
 * capability. Extracted (same pattern as sub-accounts-service) so both
 * callers hit identical guards: the `websiteEnabledByAgency` agency gate,
 * the per-sub-account site cap, gitpage configuration, config
 * normalization + validation, and the QStash poll scheduling.
 *
 * Auth stays with the callers — this module trusts its inputs.
 */

/**
 * Typed failure the routes map back to their existing JSON shapes and the
 * AI capability surfaces as a friendly chat message. `fieldErrors` is set
 * for validation failures; `gitpageStatus`/`gitpageBody` for gitpage 4xx.
 */
export class WebsiteServiceError extends Error {
  readonly status: number;
  readonly fieldErrors?: ValidationErrors;
  readonly fieldErrorsSource?: "local-validation";
  readonly failureSource?:
    | "local-gate"
    | "local-config"
    | "local-state"
    | "local-rate"
    | "local-validation"
    | "local-preparation"
    | "provider";
  readonly gitpageStatus?: number;
  readonly gitpageBody?: unknown;
  /** Set with a 429 from the hourly build limit. */
  readonly retryAfterSec?: number;
  /** Whether gitpage definitely had not accepted, definitely accepted, or
   *  may have accepted the submit when this error was raised. */
  readonly submissionOutcome?: "not-accepted" | "accepted" | "unknown";
  constructor(
    message: string,
    status: number,
    extra?: {
      fieldErrors?: ValidationErrors;
      fieldErrorsSource?: "local-validation";
      failureSource?: WebsiteServiceError["failureSource"];
      gitpageStatus?: number;
      gitpageBody?: unknown;
      retryAfterSec?: number;
      submissionOutcome?: "not-accepted" | "accepted" | "unknown";
    },
  ) {
    super(message);
    this.name = "WebsiteServiceError";
    this.status = status;
    this.fieldErrors = extra?.fieldErrors;
    this.fieldErrorsSource = extra?.fieldErrorsSource;
    this.failureSource = extra?.failureSource;
    this.gitpageStatus = extra?.gitpageStatus;
    this.gitpageBody = extra?.gitpageBody;
    this.retryAfterSec = extra?.retryAfterSec;
    this.submissionOutcome = extra?.submissionOutcome;
  }
}

function rejectedBeforeAcceptance(status: number): boolean {
  // A received client-error response normally proves the provider rejected
  // the request. Request Timeout and Too Early remain ambiguous: either can
  // arrive after an intermediary or provider has forwarded the submission.
  return status >= 400 && status < 500 && status !== 408 && status !== 425;
}

const BUSY_MESSAGE =
  "Too many website changes are being made for this workspace at once. Try again in a moment.";

const ALREADY_BUILDING_MESSAGE =
  "This site is building right now — wait for it to finish before starting another build.";

const SITE_NOT_FOUND_MESSAGE = "Website not found in this workspace.";

/** As the wizard's draft save words it (website/[siteId] PATCH). */
const UNSETTLED_FAILURE_MESSAGE =
  "This site's last build can still finish — use Re-check now, or Try again, before changing it.";

const GITPAGE_NO_BUILD_MESSAGE =
  "The website builder did not start the build. Nothing was built — try again in a few minutes.";

const GATE_OFF_MESSAGE =
  "The website builder is disabled for this sub-account. Your agency administrator can enable it from Manage in the agency sub-accounts list.";

/**
 * Load the sub-account doc + enforce the agency website gate. Throws a
 * `WebsiteServiceError` (403 gate off, 404 no such sub-account). Exported
 * for the builder's own routes that do not go through create/build — the
 * wizard draft save and the concepts proxy.
 */
export async function requireWebsiteEnabledSub(subAccountId: string): Promise<{
  agencyId: string;
  name: string | undefined;
  data: Record<string, unknown>;
}> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    throw new WebsiteServiceError("Sub-account not found", 404, {
      failureSource: "local-state",
      submissionOutcome: "not-accepted",
    });
  }
  const data = snap.data() as Record<string, unknown>;
  if (data.websiteEnabledByAgency !== true) {
    throw new WebsiteServiceError(GATE_OFF_MESSAGE, 403, {
      failureSource: "local-gate",
      submissionOutcome: "not-accepted",
    });
  }
  const agencyId = data.agencyId as string | undefined;
  if (!agencyId) {
    throw new WebsiteServiceError("Sub-account is missing agencyId.", 500, {
      failureSource: "local-config",
      submissionOutcome: "not-accepted",
    });
  }
  return { agencyId, name: data.name as string | undefined, data };
}

/**
 * Create a new (blank, draft) website doc, enforcing the gate + the
 * per-sub-account cap. Returns the new site id.
 */
export async function createWebsiteForSubAccount(input: {
  subAccountId: string;
  /** Optional operator-facing card label; defaults to "Website N". */
  name?: string;
}): Promise<{ siteId: string; agencyId: string }> {
  const { subAccountId } = input;
  // An id, never a path — as the build checks. Without this only the gate
  // read below stands between a path-shaped value and a nested create.
  if (!isDocId(subAccountId)) {
    throw new WebsiteServiceError("Sub-account not found", 404, {
      failureSource: "local-state",
      submissionOutcome: "not-accepted",
    });
  }
  const { agencyId } = await requireWebsiteEnabledSub(subAccountId);

  const db = getAdminDb();
  const col = db.collection(`subAccounts/${subAccountId}/website`);
  const ref = col.doc();
  const now = FieldValue.serverTimestamp();
  const docData: Omit<WebsiteDoc, "createdAt" | "updatedAt" | "lastBuildAt"> & {
    createdAt: FieldValue;
    updatedAt: FieldValue;
    lastBuildAt: null;
  } = {
    id: ref.id,
    agencyId,
    subAccountId,
    name: input.name?.trim() || "",
    status: "draft",
    gitpageJobId: null,
    liveUrl: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 0,
    lastBuildAt: null,
    lastBuildByUid: null,
    config: blankWebsiteConfig(),
    createdAt: now,
    updatedAt: now,
  };
  // The count and the create are one transaction, serialised on the limits
  // doc: of several creates at once, only as many as there are free slots
  // go through.
  let created: boolean;
  try {
    created = await db.runTransaction(async (tx) => {
      const slot = await siteSlotFree(tx, subAccountId);
      if (!slot.free) return false;
      tx.set(ref, { ...docData, name: docData.name || `Website ${slot.count + 1}` });
      claimSiteSlot(tx, subAccountId);
      return true;
    });
  } catch (err) {
    if (!isContention(err)) {
      throw new WebsiteServiceError("Could not create the website draft.", 500, {
        failureSource: "local-preparation",
        submissionOutcome: "not-accepted",
      });
    }
    throw new WebsiteServiceError(BUSY_MESSAGE, 429, {
      retryAfterSec: BUSY_RETRY_AFTER_SEC,
      failureSource: "local-rate",
      submissionOutcome: "not-accepted",
    });
  }
  if (!created) {
    throw new WebsiteServiceError(SITE_CAP_MESSAGE, 409, {
      failureSource: "local-state",
      submissionOutcome: "not-accepted",
    });
  }

  return { siteId: ref.id, agencyId };
}

/**
 * Normalize an untrusted WebsiteConfig in place, exactly as the build route
 * always has: hard-code system fields, default build_type, validate niche,
 * force/clean page selections per build type + niche.
 */
export function normalizeWebsiteConfig(config: WebsiteConfig): void {
  config.site_type = "LocalSite";
  config.astra_theme = false;

  if (config.build_type !== "vsl") {
    config.build_type = "local";
  }

  // Build v2: every build is premium, and the premium flags are normalised
  // to booleans. Premium only since 2026-10-01 — Standard is no longer
  // offered anywhere (UI, assistant, API). Old drafts saved as "standard"
  // build as premium.
  config.quality = "premium";
  config.include_form = config.include_form !== false;
  config.include_chat = config.include_chat !== false;
  config.include_voice = config.include_voice !== false;
  config.concept = typeof config.concept === "string" && config.concept.trim() ? config.concept.trim() : null;
  config.hero_motion = config.hero_motion ?? null;
  config.premium_details = config.premium_details ?? null;

  if (config.niche != null && !isNicheKey(config.niche)) {
    throw new WebsiteServiceError(
      "niche must be one of: home_services, real_estate, gym_fitness, agency_consulting, ai_consulting, ai_automation. Omit for a generic build.",
      400,
      {
        failureSource: "local-validation",
        submissionOutcome: "not-accepted",
      },
    );
  }
  config.niche = isNicheKey(config.niche) ? config.niche : null;

  if (config.build_type === "local") {
    if (!config.local_page_selections) {
      throw new WebsiteServiceError("local_page_selections is required.", 400, {
        failureSource: "local-validation",
        submissionOutcome: "not-accepted",
      });
    }
    config.local_page_selections.index = true;

    if (config.niche) {
      // Niche locks the page set to all five pages. Force the selections so
      // the persisted doc reflects what gitpage actually built.
      config.local_page_selections = {
        index: true,
        services: true,
        contact: true,
        privacy: true,
        terms: true,
      };
    } else {
      // Generic local: drop conditional sections that don't apply.
      if (!config.local_page_selections.services) {
        config.services_config = null;
      }
      if (!config.local_page_selections.contact) {
        config.business_details = null;
      }
    }
  } else {
    // VSL is single-page — force a clean shape so Firestore doesn't hold
    // stale data from a previous local-mode draft.
    config.local_page_selections = {
      index: true,
      services: false,
      contact: false,
      privacy: false,
      terms: false,
    };
    config.services_config = null;
    config.business_details = null;
  }
}

/**
 * Validate, submit to gitpage, persist the queued state, and schedule the
 * QStash poll for one site. Mutates `config` via normalization first.
 */
async function submitWebsiteBuildForSubAccountImpl(input: {
  subAccountId: string;
  siteId: string;
  config: WebsiteConfig;
  buildByUid: string;
  /**
   * For a caller that read the site and means to REBUILD it: a site that is
   * no longer there is refused (404) instead of being created by this build.
   */
  requireExisting?: boolean;
  /**
   * A call-to-action re-point: the build is submitted with `config`, but
   * only its `cta_link` is written back, so a wizard save that lands while
   * gitpage is being called is kept. And, as the wizard's draft save does,
   * a failed site whose last build can still finish (it has a job) is
   * refused, here and again inside the write. Implies `requireExisting`.
   */
  ctaOnly?: boolean;
}, state: { providerSubmitStarted: boolean }): Promise<{
  formResponseId: string;
  estimatedDurationSeconds?: number;
}> {
  const { subAccountId, siteId, config } = input;
  // Ids, never paths. Both go into Firestore paths below; a site id like
  // "x/y/z" would address (and, on a first build, create) a doc in a nested
  // collection that the site cap does not count.
  if (!isDocId(subAccountId) || !isDocId(siteId)) {
    throw new WebsiteServiceError("Website not found.", 404, {
      failureSource: "local-state",
      submissionOutcome: "not-accepted",
    });
  }
  const { agencyId, name: subAccountName } =
    await requireWebsiteEnabledSub(subAccountId);

  if (!gitpageIsConfigured()) {
    throw new WebsiteServiceError(
      "gitpage is not configured on this deployment (GITPAGE_API_KEY missing).",
      503,
      {
        failureSource: "local-config",
        submissionOutcome: "not-accepted",
      },
    );
  }

  normalizeWebsiteConfig(config);

  const errors = validateWebsiteConfig(config);
  if (Object.keys(errors).length > 0) {
    throw new WebsiteServiceError("Validation failed.", 400, {
      fieldErrors: errors,
      fieldErrorsSource: "local-validation",
      failureSource: "local-validation",
      submissionOutcome: "not-accepted",
    });
  }

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  // A CTA re-point is a rebuild by definition: it never creates a site.
  if ((input.requireExisting || input.ctaOnly) && !snap.exists) {
    throw new WebsiteServiceError(SITE_NOT_FOUND_MESSAGE, 404, {
      failureSource: "local-state",
      submissionOutcome: "not-accepted",
    });
  }
  const isFirst = !snap.exists;
  const existingDoc = (snap.data() ?? {}) as Partial<WebsiteDoc>;

  // Refuse before anything is spent. A site already building keeps its job:
  // a second submit would start a second paid build and orphan the first.
  // (The write below re-checks this atomically; this is the cheap early no.)
  if (existingDoc.status === "queued" || existingDoc.status === "building") {
    throw new WebsiteServiceError(ALREADY_BUILDING_MESSAGE, 409, {
      failureSource: "local-state",
      submissionOutcome: "not-accepted",
    });
  }
  if (input.ctaOnly && hasUnsettledFailure(existingDoc)) {
    throw new WebsiteServiceError(UNSETTLED_FAILURE_MESSAGE, 409, {
      failureSource: "local-state",
      submissionOutcome: "not-accepted",
    });
  }
  // A build on an id that has no doc creates one, so it counts against the
  // per-sub-account cap exactly as `createWebsiteForSubAccount` does. This
  // is the early no, before anything is spent; the write below enforces the
  // cap atomically with the creation.
  if (isFirst) {
    const existing = await db.collection(`subAccounts/${subAccountId}/website`).get();
    if (existing.size >= MAX_WEBSITES_PER_SUBACCOUNT) {
      throw new WebsiteServiceError(SITE_CAP_MESSAGE, 409, {
        failureSource: "local-state",
        submissionOutcome: "not-accepted",
      });
    }
  }
  // The real bound on calls to gitpage. The 409 above stops a second build
  // of a site that is building, but two submits in the same instant both
  // pass it; this counter is what neither
  // can get round.
  const rate = await reserveBuildSubmit(subAccountId);
  if (!rate.ok) {
    throw new WebsiteServiceError(
      rate.busy
        ? BUSY_MESSAGE
        : `This workspace has started ${WEBSITE_BUILDS_PER_HOUR} website builds in the last hour. Try again later.`,
      429,
      {
        retryAfterSec: rate.retryAfterSec,
        failureSource: "local-rate",
        submissionOutcome: "not-accepted",
      },
    );
  }

  // Premium: make sure the sub-account's "Website contact" form exists BEFORE
  // the request, because gitpage bakes its submit URL into the site. Reused
  // across rebuilds (and across sites in the workspace).
  let formId: string | null = null;
  if (wantsLeadForm(config)) {
    try {
      formId = await ensureWebsiteContactForm({
        subAccountId,
        createdByUid: input.buildByUid,
        existingFormId: existingDoc.formId ?? null,
      });
    } catch (err) {
      throw new WebsiteServiceError(
        `Could not prepare the website contact form: ${err instanceof Error ? err.message : String(err)}`,
        500,
        {
          failureSource: "local-preparation",
          submissionOutcome: "not-accepted",
        },
      );
    }
  }
  const publicAppUrl = await resolvedAppUrl();
  const leadstack =
    config.quality === "premium"
      ? leadstackWiringFor({ subAccountId, formId, config, appUrl: publicAppUrl }) ?? undefined
      : undefined;
  if (config.quality === "premium" && !leadstack) {
    console.warn(
      "[website/build] NEXT_PUBLIC_APP_URL is not a public https URL — the premium site will carry no LeadStack form/widget wiring",
    );
  }
  const callbackUrl = buildSettledCallbackUrl(publicAppUrl) ?? undefined;

  // The builder gets editor access to the new gitpage site (so they can
  // edit it with the GitPage MCP). Best-effort: no email → no invite.
  let editorEmail: string | undefined;
  try {
    const u = await getAdminAuth().getUser(input.buildByUid);
    editorEmail = u.email?.trim().toLowerCase() || undefined;
  } catch (err) {
    console.warn(
      `[website/build] could not read the builder's email — no editor invite sa=${subAccountId} site=${siteId} uid=${input.buildByUid}`,
      err,
    );
    editorEmail = undefined;
  }

  // Submit to gitpage. On 4xx surface their error verbatim; on 5xx /
  // network failure tell the caller we couldn't reach gitpage.
  let submission;
  try {
    state.providerSubmitStarted = true;
    submission = await submitBuild({
      config,
      subAccountId,
      subAccountName,
      leadstack,
      callbackUrl,
      editorEmail,
    });
  } catch (err) {
    // Whatever happened, the reservation taken above stays taken — an HTTP
    // error and a request that threw alike. A throw does not prove gitpage
    // was not reached (a timeout, an answer lost after the request was
    // sent), so giving the reservation back would let a caller who can make
    // requests fail that way start builds without limit.

    // HARDENING: gitpage answered 2xx but the answer was not a build (no job
    // id / poll URL). Forwarding its status would make the caller's reply a
    // success while nothing was recorded, so it is an upstream failure with
    // fixed text; gitpage's body stays in the log, not the reply.
    if (err instanceof GitpageError && err.status < 400) {
      console.error(
        `[website/build] gitpage answered ${err.status} without a build sa=${subAccountId} site=${siteId}: ${err.message}`,
      );
      throw new WebsiteServiceError(GITPAGE_NO_BUILD_MESSAGE, 502, {
        failureSource: "provider",
        submissionOutcome: "unknown",
      });
    }
    if (err instanceof GitpageError) {
      // 401 means the API key is invalid (rotated upstream, never set,
      // typo'd). Flip the cached status so the UI surfaces the correct CTA.
      if (err.status === 401) {
        await markGitpageKeyInvalid();
      }
      throw new WebsiteServiceError(err.message, err.status, {
        gitpageStatus: err.status,
        gitpageBody: err.body,
        failureSource: "provider",
        submissionOutcome: rejectedBeforeAcceptance(err.status)
          ? "not-accepted"
          : "unknown",
      });
    }
    throw new WebsiteServiceError(
      err instanceof Error ? err.message : "Could not reach gitpage.",
      502,
      { failureSource: "provider", submissionOutcome: "unknown" },
    );
  }

  // The build was accepted (202) — stronger activation evidence than the
  // heartbeat; clear any stale `agency: false` cache.
  await markGitpageBuildSucceeded();

  const update: Partial<Omit<WebsiteDoc, "config">> & {
    config: WebsiteConfig | Pick<WebsiteConfig, "cta_link">;
    updatedAt: FieldValue;
  } = {
    // Set-merge: a map here is merged field by field into the stored one.
    config: input.ctaOnly ? { cta_link: config.cta_link } : config,
    status: "queued",
    gitpageJobId: submission.formResponseId,
    liveUrl: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 0,
    lastBuildAt: FieldValue.serverTimestamp() as unknown as null,
    lastBuildByUid: input.buildByUid,
    updatedAt: FieldValue.serverTimestamp(),
    // Build v2 bookkeeping.
    quality: config.quality ?? "premium",
    formId,
    estimatedDurationSeconds: submission.estimatedDurationSeconds ?? null,
    statusPhase: null,
    conceptName: null,
    provisioning: null,
    gitpagePageId: null,
    editorEmail: editorEmail ?? null,
    settledDelivery: null,
  };

  if (isFirst) {
    // The doc is normally created up-front, but a direct build on a
    // never-created id (e.g. the legacy `main`) still stamps tenancy.
    Object.assign(update, {
      id: siteId,
      agencyId,
      subAccountId,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  // Atomic with the status check: of two submits that both passed the early
  // check above, one takes the site and the other is told it is building.
  // The doc is created only if THIS submit read it as absent (`isFirst`): a
  // site removed while gitpage was being called stays removed. gitpage has
  // accepted the loser's build in each of these cases — it is logged, and
  // nothing here tracks it; the hourly counter bounds how often that can be.
  const orphaned = (why: string) =>
    console.error(
      `[website/build] build not recorded (${why}) sa=${subAccountId} site=${siteId} orphanedJob=${submission.formResponseId}`,
    );
  let taken: WebsiteTransitionResult;
  try {
    taken = await transitionWebsite(
      docRef,
      {
        fromStatuses: ["draft", "ready", "failed"],
        orMissing: isFirst,
        merge: true,
        ...(input.ctaOnly ? { when: (fresh: WebsiteDoc) => !hasUnsettledFailure(fresh) } : {}),
      },
      update,
    );
  } catch (err) {
    orphaned(isContention(err) ? "contention" : "write failed");
    if (!isContention(err)) throw err;
    throw new WebsiteServiceError(BUSY_MESSAGE, 429, {
      retryAfterSec: BUSY_RETRY_AFTER_SEC,
      failureSource: "local-state",
      submissionOutcome: "accepted",
    });
  }
  if (!taken.applied) {
    orphaned(taken.reason);
    throw new WebsiteServiceError(
      taken.reason === "missing"
        ? "This site was removed while its build was being submitted."
        : taken.reason === "cap"
          ? SITE_CAP_MESSAGE
          : taken.reason === "condition"
            ? UNSETTLED_FAILURE_MESSAGE
            : ALREADY_BUILDING_MESSAGE,
      409,
      { failureSource: "local-state", submissionOutcome: "accepted" },
    );
  }

  // Schedule the first QStash poll. Without QStash the build doc just sits
  // at "queued" — verifiable in gitpage's dashboard; don't fail the request.
  if (qstashIsConfigured()) {
    const queued = await publishCallback({
      pathname: `/api/sub-accounts/${subAccountId}/website/${siteId}/poll`,
      body: {
        subAccountId,
        siteId,
        formResponseId: submission.formResponseId,
      },
      delaySeconds: WEBSITE_POLL_INTERVAL_SECONDS,
      deduplicationId: `website_${subAccountId}_${siteId}_${submission.formResponseId}_0`,
    });
    // publishCallback never throws: null = not queued. Same settle as the
    // poll route's dead chain; the job id stays, so Re-check now can resume.
    if (!queued) {
      console.error(`[website/build] first poll not queued sa=${subAccountId} site=${siteId}`);
      await transitionWebsite(
        docRef,
        { expectJobId: submission.formResponseId, fromStatuses: ["queued"] },
        {
          status: "failed",
          errorMessage: "Couldn't schedule the next poll. Use Re-check now, or Try again.",
          updatedAt: FieldValue.serverTimestamp(),
        },
      );
    }
  } else {
    console.warn(
      "[website/build] QStash not configured — status will sit at queued",
    );
  }

  return {
    formResponseId: submission.formResponseId,
    estimatedDurationSeconds: submission.estimatedDurationSeconds,
  };
}

/** Classify every failure before the provider call as a definite local
 * refusal. Once submitBuild starts, the implementation's provider/accepted
 * classification is authoritative and must pass through unchanged. */
export async function submitWebsiteBuildForSubAccount(
  input: Parameters<typeof submitWebsiteBuildForSubAccountImpl>[0],
): Promise<{ formResponseId: string; estimatedDurationSeconds?: number }> {
  const state = { providerSubmitStarted: false };
  try {
    return await submitWebsiteBuildForSubAccountImpl(input, state);
  } catch (err) {
    if (state.providerSubmitStarted) throw err;
    if (
      err instanceof WebsiteServiceError &&
      err.submissionOutcome === "not-accepted"
    ) {
      throw err;
    }
    if (err instanceof WebsiteServiceError) {
      throw new WebsiteServiceError(err.message, err.status, {
        fieldErrors: err.fieldErrors,
        fieldErrorsSource: err.fieldErrorsSource,
        failureSource: err.failureSource ?? "local-preparation",
        gitpageStatus: err.gitpageStatus,
        gitpageBody: err.gitpageBody,
        retryAfterSec: err.retryAfterSec,
        submissionOutcome: "not-accepted",
      });
    }
    throw new WebsiteServiceError("Website build preparation failed.", 500, {
      failureSource: "local-preparation",
      submissionOutcome: "not-accepted",
    });
  }
}

/**
 * The premium publish hand-off, for the ONE caller that won the settle
 * claim. Never allowed to fail the publish: it runs after the site is
 * `ready`, a throw is recorded on `provisioning` instead of surfacing, and
 * the only thing it writes to the site doc is `provisioning` — through
 * `transitionWebsite`, for this job, while the site is still `ready`. So it
 * cannot un-settle or re-settle a site, and a summary for a build that has
 * since been replaced or removed is dropped rather than written onto its
 * successor.
 *
 * A gated-off workspace (`websiteEnabledByAgency`) gets no hand-off: the
 * service returns null and `provisioning` is left as it is.
 */
async function runWebsiteHandoff(input: HandoffInput & { jobId: string }): Promise<void> {
  const { subAccountId, siteId, site, jobId } = input;
  let provisioning: WebsiteProvisioning | null;
  try {
    provisioning = await provisionWebsiteHandoff(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[website/settle] hand-off threw sa=${subAccountId} site=${siteId}: ${message}`);
    provisioning = blankProvisioning(site.formId ?? null, [message]);
  }
  if (!provisioning) return;
  try {
    await transitionWebsite(
      getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`),
      { expectJobId: jobId, fromStatuses: ["ready"] },
      { provisioning, updatedAt: FieldValue.serverTimestamp() },
    );
  } catch (err) {
    console.error(
      `[website/settle] hand-off summary not recorded sa=${subAccountId} site=${siteId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Settle a build that gitpage reports as terminal — shared by the QStash
 * poll tick, the manual Re-check and the `build.settled` callback so every
 * path writes the same doc state and runs the same premium hand-off.
 *
 * Settles ONCE per job, through `transitionWebsite`: the doc must still
 * carry the job the caller read, and be queued or building — or `failed`
 * when the caller is the manual re-check (it read "failed") or gitpage now
 * reports Published (the poll cap gave up first; a 4xx was transient).
 * `ready` is never written over, and never turned into `failed`. A caller
 * that loses — the callback and a poll tick both read "building" — gets
 * "noop" and runs nothing, so the hand-off cannot run twice for one
 * publish. (Upstream leaves this to each caller's own read of the status,
 * which two concurrent callers both pass.)
 *
 * Also "noop", with nothing written:
 *  - Published with NO live URL (`isSettleable`): a site is not ready
 *    without an address, so the poll finishes it when gitpage has one.
 *  - A repeat of the report already applied for this job
 *    (`settledDelivery`) while the site is still settled that way. The
 *    record is cleared whenever the site goes back in flight (a resume, a
 *    new build), so a second, genuine failure of a resumed build lands.
 *
 * Published with an address that was REFUSED settles as `failed`, with a
 * message naming the address: the site exists at gitpage, we will not link
 * to it, and the operator has to be told rather than left polling.
 *
 * The `websiteEnabledByAgency` gate is deliberately NOT checked here, nor in
 * the three routes that end here (the QStash poll, Re-check now, the
 * `build.settled` callback) — as upstream. The gate stops NEW work: create,
 * build, the draft save and the concepts proxy all 403. A build submitted
 * while the gate was on has already been accepted by gitpage and will
 * publish there whatever we do; refusing to record that would leave the doc
 * "building" forever, with a live site the card cannot show, and docs/
 * architecture/feature-gates.md promises the published site is preserved
 * when the gate goes off. So settling only makes the doc truthful.
 * The hand-off is different — it does new work in the workspace (the chat
 * allowlist, a workflow) — and does check the gate: a gated-off workspace's
 * site is settled and nothing more (`provisionWebsiteHandoff`).
 *
 * The hand-off runs after the response (`runAfterResponse`), registered
 * here while the caller's request is still open — every caller is a request
 * handler: the QStash tick, Re-check now, the callback.
 */
export async function settleWebsiteBuild(input: {
  subAccountId: string;
  siteId: string;
  site: WebsiteDoc;
  result: PollBuildResult;
  /** Poll attempts so far (0 for the callback path). */
  attempts: number;
}): Promise<"ready" | "failed" | "noop"> {
  const { subAccountId, siteId, site, result } = input;
  const jobId = site.gitpageJobId;
  if (!jobId || !isSettleable(result)) return "noop";
  const docRef = getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`);
  // "published" below means: will be written as ready. Published at a
  // refused address is settled as a failure.
  const published = result.status === "Published" && !!result.pagesUrl;
  const refused = result.status === "Published" && !published ? result.pagesUrlRefused : null;
  if (refused) {
    console.error(
      `[website/settle] refused live URL sa=${subAccountId} site=${siteId} job=${jobId} url=${JSON.stringify(refused)}`,
    );
  }
  const delivery = { jobId, status: published ? ("Published" as const) : ("failed" as const) };

  // GitLab path URLs 308 to the project's unique domain — store and wire the
  // URL visitors actually land on. Resolved before the claim so the site is
  // never `ready` at one address and then moved to another.
  const live = published && result.pagesUrl ? await resolveLiveUrl(result.pagesUrl) : null;
  const liveUrl = live?.url ?? null;

  const settled = await transitionWebsite(
    docRef,
    {
      expectJobId: jobId,
      fromStatuses: ["queued", "building", "failed"],
      when: (fresh) => {
        const repeat =
          fresh.settledDelivery?.jobId === delivery.jobId &&
          fresh.settledDelivery.status === delivery.status;
        if (repeat) return false;
        return fresh.status !== "failed" || published || site.status === "failed";
      },
    },
    published
      ? {
          status: "ready",
          liveUrl,
          errorMessage: null,
          partialErrors: result.partialErrors,
          statusPhase: "completed",
          conceptName: result.premium?.theme?.conceptName ?? null,
          ...(result.pageId ? { gitpagePageId: result.pageId } : {}),
          pollAttempts: input.attempts,
          settledDelivery: delivery,
          updatedAt: FieldValue.serverTimestamp(),
        }
      : {
          status: "failed",
          errorMessage: refused
            ? `gitpage published this site at an address that was refused: "${refused}". Only a public https address is accepted.`
            : (result.error ?? "gitpage build failed without details."),
          statusPhase: result.premium?.failedStage ?? result.statusPhase ?? null,
          pollAttempts: input.attempts,
          settledDelivery: delivery,
          updatedAt: FieldValue.serverTimestamp(),
        },
  );
  if (!settled.applied) return "noop";
  if (!published) return "failed";

  // Not ported (WS-4 review): upstream schedules a post-publish PageSpeed
  // check here (a QStash call to a public `…/website/[siteId]/pagespeed`
  // route). It only stores scores that nothing displays, upstream included,
  // so it would spend a QStash message per publish for nothing.

  // Premium hand-off, for the caller that claimed — and only that caller: a
  // "noop" above has already returned.
  const quality = site.quality ?? effectiveQuality(site.config);
  if (quality === "premium" && liveUrl) {
    runAfterResponse(() =>
      runWebsiteHandoff({
        subAccountId,
        siteId,
        site,
        config: { ...blankWebsiteConfig(), ...(site.config ?? {}) },
        liveUrl,
        liveUrlResolved: live?.resolved ?? false,
        result,
        jobId,
      }),
    );
  }
  return "ready";
}

/**
 * The call-to-action link a rebuild may publish, or null. Held to the rule
 * for a gitpage live URL (`safePagesUrl`): no whitespace or control
 * characters, parses, `https:`, no embedded credentials, not localhost or a
 * non-public IP literal, at most 2,048 characters. The site renders it as a
 * link on a public page, so `http:`, `javascript:` and `data:` never reach
 * the stored config. Returned in `URL.href` form.
 */
export function safeCtaLink(raw: unknown): string | null {
  return safePagesUrl(raw);
}

/** A failed build that still has a job: gitpage may yet finish it. */
export function hasUnsettledFailure(doc: Partial<WebsiteDoc>): boolean {
  return doc.status === "failed" && !!doc.gitpageJobId;
}

/** Private-use, unassigned and lone-surrogate code points: `oneLine` keeps
 *  them, `hasUnsafeText` refuses them. */
const UNPRINTABLE_RE = /[\p{Co}\p{Cn}\p{Cs}]/gu;

/** The longest site name update_website_cta's card takes (UTF-16 units). */
export const SITE_NAME_MAX = 200;

/**
 * A site's name as every assistant lookup prints it and as
 * `updateWebsiteCtaAndRebuild` checks a confirmed name against: the name,
 * else the heading, else "Untitled site" — on one line, with nothing the
 * assistant's own input check (`hasUnsafeText`) would refuse, so any name
 * a lookup prints can be sent back.
 */
export function siteDisplayName(site: { name?: unknown; config?: unknown }): string {
  const clean = (v: unknown) => {
    // oneLine collapses whitespace before it strips invisibles, so "a <ZWSP> b"
    // comes out with two spaces; collapse again, so oneLine of the result
    // is the result (the card's name is compared through oneLine).
    const line = oneLine(String(v ?? "").replace(UNPRINTABLE_RE, "")).replace(/ {2,}/g, " ");
    // At most SITE_NAME_MAX UTF-16 units (the card's limit), never splitting
    // a surrogate pair. oneLine again: a cut between a keycap's U+FE0F and
    // its U+20E3 leaves a selector that is no longer a presentation one.
    let out = "";
    for (const ch of line) {
      if (out.length + ch.length > SITE_NAME_MAX) break;
      out += ch;
    }
    return out.length < line.length ? oneLine(out) : line;
  };
  const heading = (site.config as { heading?: unknown } | null | undefined)?.heading;
  return clean(site.name) || clean(heading) || "Untitled site";
}

/**
 * Point a site's call-to-action at a new URL and rebuild it. This is the one
 * seam between a gitpage site and the CRM: the site config carries no form
 * reference, so "link the site to my form" means setting `cta_link` to the
 * form's (or a booking page's) public URL and resubmitting the build.
 *
 * The build goes through `submitWebsiteBuildForSubAccount` and nothing else,
 * so every guard there applies unchanged: the agency gate, the gitpage key,
 * config validation, the refusal while a build is in flight, the hourly
 * build counter and the `transitionWebsite` write. `requireExisting` closes
 * the one gap of reading the site here first: a site removed in between is
 * refused, not re-created by the build. (Upstream, 68798611, takes any
 * http(s) link, reads the site before the gate, and has that gap.)
 *
 * The rebuild submits the STORED config, so wizard edits saved since the
 * last build are published with it.
 */
export async function updateWebsiteCtaAndRebuild(input: {
  subAccountId: string;
  siteId: string;
  ctaLink: string;
  buildByUid: string;
  /**
   * The site's name as the confirming person was shown it. The id and the
   * name both come from the model; a card naming one site while the id is
   * another's must not rebuild the other.
   */
  expectSiteName?: string;
}): Promise<{
  formResponseId: string;
  siteName: string;
  ctaLink: string;
  previousCtaLink: string;
}> {
  const { subAccountId, siteId } = input;
  if (!isDocId(subAccountId) || !isDocId(siteId)) {
    throw new WebsiteServiceError(SITE_NOT_FOUND_MESSAGE, 404);
  }
  const ctaLink = safeCtaLink(input.ctaLink);
  if (!ctaLink) {
    throw new WebsiteServiceError(
      "The call-to-action link must be a full public https:// URL (at most 2,048 characters).",
      400,
    );
  }
  // The gate answers first, as for every other website write.
  await requireWebsiteEnabledSub(subAccountId);

  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}/website/${siteId}`).get();
  const doc = snap.data() as WebsiteDoc | undefined;
  if (!doc || doc.subAccountId !== subAccountId) {
    throw new WebsiteServiceError(SITE_NOT_FOUND_MESSAGE, 404);
  }
  const config: WebsiteConfig = { ...blankWebsiteConfig(), ...(doc.config ?? {}) };
  const siteName = siteDisplayName(doc);
  if (
    input.expectSiteName !== undefined &&
    oneLine(input.expectSiteName).toLowerCase() !== siteName.toLowerCase()
  ) {
    throw new WebsiteServiceError(
      `That website id belongs to “${siteName}”, not “${oneLine(input.expectSiteName)}” — nothing was changed. Check the site's id and name again.`,
      409,
    );
  }
  const previousCtaLink = (config.cta_link ?? "").trim();
  // A live site that already carries the link: a rebuild would spend a build
  // to publish the same thing. (A failed or unbuilt one may still need it.)
  // Compared as `URL.href` (as `ctaLink` is): a stored link typed without
  // the trailing slash or with an upper-case host is the same link.
  if (doc.status === "ready" && (safeCtaLink(previousCtaLink) ?? previousCtaLink) === ctaLink) {
    throw new WebsiteServiceError(
      `“${siteName}” is live with that call-to-action link already — nothing to change, so no rebuild was started.`,
      409,
    );
  }
  config.cta_link = ctaLink;

  const submission = await submitWebsiteBuildForSubAccount({
    subAccountId,
    siteId,
    config,
    buildByUid: input.buildByUid,
    requireExisting: true,
    ctaOnly: true,
  });
  return { formResponseId: submission.formResponseId, siteName, ctaLink, previousCtaLink };
}
