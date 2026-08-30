import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { MAX_WEBSITES_PER_SUBACCOUNT } from "@/lib/website/limits";
import {
  validateWebsiteConfig,
  type ValidationErrors,
} from "@/lib/website/validation";
import { isNicheKey } from "@/lib/website/niches";
import {
  GitpageError,
  gitpageIsConfigured,
  submitBuild,
} from "@/lib/gitpage/client";
import {
  markGitpageBuildSucceeded,
  markGitpageKeyInvalid,
} from "@/lib/gitpage/heartbeat";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import {
  blankWebsiteConfig,
  type WebsiteConfig,
  type WebsiteDoc,
} from "@/types/website";

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
  readonly gitpageStatus?: number;
  readonly gitpageBody?: unknown;
  constructor(
    message: string,
    status: number,
    extra?: { fieldErrors?: ValidationErrors; gitpageStatus?: number; gitpageBody?: unknown },
  ) {
    super(message);
    this.name = "WebsiteServiceError";
    this.status = status;
    this.fieldErrors = extra?.fieldErrors;
    this.gitpageStatus = extra?.gitpageStatus;
    this.gitpageBody = extra?.gitpageBody;
  }
}

const GATE_OFF_MESSAGE =
  "The website builder is disabled for this sub-account. Your agency administrator can enable it from Manage in the agency sub-accounts list.";

/** Load the sub-account doc + enforce the agency website gate. */
async function requireWebsiteEnabledSub(subAccountId: string): Promise<{
  agencyId: string;
  name: string | undefined;
  data: Record<string, unknown>;
}> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!snap.exists) {
    throw new WebsiteServiceError("Sub-account not found", 404);
  }
  const data = snap.data() as Record<string, unknown>;
  if (data.websiteEnabledByAgency !== true) {
    throw new WebsiteServiceError(GATE_OFF_MESSAGE, 403);
  }
  const agencyId = data.agencyId as string | undefined;
  if (!agencyId) {
    throw new WebsiteServiceError("Sub-account is missing agencyId.", 500);
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
  const { agencyId } = await requireWebsiteEnabledSub(subAccountId);

  const db = getAdminDb();
  const col = db.collection(`subAccounts/${subAccountId}/website`);
  const existing = await col.get();
  if (existing.size >= MAX_WEBSITES_PER_SUBACCOUNT) {
    throw new WebsiteServiceError(
      `You can create up to ${MAX_WEBSITES_PER_SUBACCOUNT} websites per sub-account. Remove one to add another.`,
      409,
    );
  }

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
    name: input.name?.trim() || `Website ${existing.size + 1}`,
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
  await ref.set(docData);

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

  if (config.niche != null && !isNicheKey(config.niche)) {
    throw new WebsiteServiceError(
      "niche must be one of: home_services, real_estate, gym_fitness. Omit for a generic build.",
      400,
    );
  }
  config.niche = isNicheKey(config.niche) ? config.niche : null;

  if (config.build_type === "local") {
    if (!config.local_page_selections) {
      throw new WebsiteServiceError("local_page_selections is required.", 400);
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
export async function submitWebsiteBuildForSubAccount(input: {
  subAccountId: string;
  siteId: string;
  config: WebsiteConfig;
  buildByUid: string;
}): Promise<{ formResponseId: string; estimatedDurationSeconds?: number }> {
  const { subAccountId, siteId, config } = input;
  const { agencyId, name: subAccountName } =
    await requireWebsiteEnabledSub(subAccountId);

  if (!gitpageIsConfigured()) {
    throw new WebsiteServiceError(
      "gitpage is not configured on this deployment (GITPAGE_API_KEY missing).",
      503,
    );
  }

  normalizeWebsiteConfig(config);

  const errors = validateWebsiteConfig(config);
  if (Object.keys(errors).length > 0) {
    throw new WebsiteServiceError("Validation failed.", 400, {
      fieldErrors: errors,
    });
  }

  // Submit to gitpage. On 4xx surface their error verbatim; on 5xx /
  // network failure tell the caller we couldn't reach gitpage.
  let submission;
  try {
    submission = await submitBuild({
      config,
      subAccountId,
      subAccountName,
    });
  } catch (err) {
    if (err instanceof GitpageError) {
      // 401 means the API key is invalid (rotated upstream, never set,
      // typo'd). Flip the cached status so the UI surfaces the correct CTA.
      if (err.status === 401) {
        await markGitpageKeyInvalid();
      }
      throw new WebsiteServiceError(err.message, err.status, {
        gitpageStatus: err.status,
        gitpageBody: err.body,
      });
    }
    throw new WebsiteServiceError(
      err instanceof Error ? err.message : "Could not reach gitpage.",
      502,
    );
  }

  // The build was accepted (202) — stronger activation evidence than the
  // heartbeat; clear any stale `agency: false` cache.
  await markGitpageBuildSucceeded();

  const db = getAdminDb();
  const docRef = db.doc(`subAccounts/${subAccountId}/website/${siteId}`);
  const snap = await docRef.get();
  const isFirst = !snap.exists;

  const update: Partial<WebsiteDoc> & {
    config: WebsiteConfig;
    updatedAt: FieldValue;
  } = {
    config,
    status: "queued",
    gitpageJobId: submission.formResponseId,
    liveUrl: null,
    errorMessage: null,
    partialErrors: null,
    pollAttempts: 0,
    lastBuildAt: FieldValue.serverTimestamp() as unknown as null,
    lastBuildByUid: input.buildByUid,
    updatedAt: FieldValue.serverTimestamp(),
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

  await docRef.set(update, { merge: true });

  // Schedule the first QStash poll. Without QStash the build doc just sits
  // at "queued" — verifiable in gitpage's dashboard; don't fail the request.
  if (qstashIsConfigured()) {
    await publishCallback({
      pathname: `/api/sub-accounts/${subAccountId}/website/${siteId}/poll`,
      body: {
        subAccountId,
        siteId,
        formResponseId: submission.formResponseId,
      },
      delaySeconds: 20,
      deduplicationId: `website_${subAccountId}_${siteId}_${submission.formResponseId}_0`,
    });
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
