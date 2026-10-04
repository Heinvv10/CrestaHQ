import "server-only";

import type { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  bumpApiKeyLastUsed,
  findApiKeyByPrefix,
  type ApiKeyOwner,
} from "@/lib/firestore/api-keys";
import {
  hashApiKey,
  parseApiKey,
  safeEqualHash,
} from "@/lib/api/keys";
import {
  apiError,
  apiOk,
  newRequestId,
  type ResponseMeta,
} from "@/lib/api/responses";
import {
  LATEST_API_VERSION,
  resolveVersion,
} from "@/lib/api/versions";
import {
  fingerprintRequest,
  isValidIdempotencyKey,
  reserveIdempotencyKey,
  type IdempotencyReservation,
} from "@/lib/api/idempotency";
import {
  checkAndCount as checkRateLimit,
  snapshotRemaining,
} from "@/lib/api/rate-limit";
import { resolveEnrolmentCapPerHour } from "@/lib/api/enrolment-cap";
import { captureRequestLog } from "@/lib/api/logs";
import { MAX_BODY_BYTES } from "@/lib/api/body-limit";
import { bodyTooLarge, invalidParam, readJsonBody } from "@/lib/api/request-guards";
import type { ApiKeyDoc, ApiKeyMode, ApiKeyScope } from "@/types/api";

/**
 * Public-API request lifecycle: auth → version resolve → (optional)
 * idempotency check → handler → response capture.
 *
 * Two entry points:
 *
 *   - `authenticateApiRequest(request)` — low-level. Returns either an
 *     `ApiAuthContext` (auth resolved, headers parsed, request id minted)
 *     OR a NextResponse with a Stripe-shaped error body. Use this when a
 *     route needs full control over body parsing or idempotency semantics.
 *
 *   - `withApiAuth(handler, opts)` — high-level. Composes auth + body
 *     parsing + idempotency cache + response headers. Most v1 routes
 *     should use this. The handler receives a typed input bundle and
 *     returns a NextResponse (built via `apiOk` / `apiError`).
 *
 * Tenancy enforcement: the resolved `ApiAuthContext` carries
 * `{agencyId, subAccountId}` from the key doc. Every downstream
 * Firestore write MUST stamp these onto the doc — the API layer does NOT
 * run inside Firestore rules (writes go via Admin SDK), so tenancy is
 * code-enforced. The cost of forgetting is a cross-tenant leak, so
 * subsequent slices ship `requireApiTenancy(ctx, doc)` guards that
 * compare `doc.subAccountId` to `ctx.subAccountId` before returning.
 *
 * An agency key (`agencies/{id}/apiKeys`) authenticates as an
 * `AgencyApiAuthContext`, which has no sub-account. `withApiAuth` and
 * `/api/mcp` refuse it, so every handler still receives an `ApiAuthContext`
 * with a real `subAccountId`.
 */

interface ApiAuthFields extends ResponseMeta {
  /** Identifies the key holder for this request. Tenancy keys for writes. */
  agencyId: string;
  keyId: string;
  /** First 8 chars of the key — surfaced in logs / errors, never secret. */
  keyPrefix: string;
  /** Operator-supplied key label ("Zapier production"). */
  keyName: string;
  /** Live data plane or sandboxed test namespace. */
  mode: ApiKeyMode;
  /** Scopes granted to this key. Check before resource access. */
  scopes: ApiKeyScope[];
  /**
   * Resolved hourly workflow-enrolment cap for this key (see
   * `lib/api/enrolment-cap.ts`) — already validated/clamped, ready to pass
   * straight to `openEnrolmentGate`.
   */
  enrolmentCapPerHour: number;
}

/** A sub-account key: every v1 route and the agent transports run on this. */
export interface ApiAuthContext extends ApiAuthFields {
  level: "sub-account";
  subAccountId: string;
}

/** An agency key: reaches no sub-account of its own. */
export interface AgencyApiAuthContext extends ApiAuthFields {
  level: "agency";
  subAccountId: null;
}

export interface WithApiAuthOptions {
  /** Required scope. Defaults to "admin". */
  requireScope?: ApiKeyScope;
  /**
   * Override the auto-detect for idempotency caching. Default behaviour:
   * cache when method is POST / PATCH / DELETE AND an `Idempotency-Key`
   * header is present. Set `false` to force-skip even when headers say
   * otherwise (rare — e.g. an internal admin endpoint that must always
   * re-execute).
   */
  idempotency?: boolean;
  /**
   * Which bodies the request log must NOT keep (default: keep both). The
   * agent tools route redacts both for a read tool: its args (a searched
   * email) and its result (tenant data) are PII, so a read logs status +
   * latency only. Applied on every exit path.
   */
  redactLog?: (params: Record<string, string>) => { requestBody: boolean; responseBody: boolean };
  /**
   * Runs after auth, scope and rate limit, BEFORE the idempotency lookup: a
   * non-null response ends the request (and is never cached). The agent
   * tools routes check test mode and the Agent API gate here, so an
   * idempotent replay can't outlive a gate switched off.
   */
  precheck?: (ctx: ApiAuthContext) => Promise<NextResponse | null>;
  /**
   * Per-request veto of the idempotency cache (default: cache as usual).
   * The agent tools route returns false for read tools (a read is naturally
   * idempotent, and caching its result would persist tenant data), and
   * stores only real outcomes, never a refusal that would replay forever.
   */
  cacheIdempotently?: (
    params: Record<string, string>,
    /** Absent: "take part in idempotency at all?" (before the lookup).
     *  Present: "store this outcome?" (after the handler; the default stores
     *  anything below 500). */
    outcome?: { status: number; body: unknown },
  ) => boolean;
  /** Body cap in bytes (default MAX_BODY_BYTES); over it -> 413 body_too_large. */
  maxBodyBytes?: number;
  /** Route params are doc ids, refused with 400 invalid_id unless isDocId
   *  (default true). The agent tools route sets false: a tool name is a
   *  registry key, never a path, and a bad one is the unknown-tool 404. */
  docIdParams?: boolean;
}

export interface ApiHandlerInput<P extends Record<string, string> = Record<string, string>> {
  request: Request;
  params: P;
  /** Parsed JSON body, or null when body is empty / not JSON. */
  body: unknown;
  /** Raw body string. Used by idempotency fingerprinting. */
  rawBody: string;
  ctx: ApiAuthContext;
}

const METHODS_WITH_IDEMPOTENCY = new Set(["POST", "PATCH", "DELETE", "PUT"]);

function readBearerToken(request: Request): string | null {
  const authz = request.headers.get("authorization") ?? "";
  const trimmed = authz.trim();
  if (!trimmed) return null;
  // Stripe-style: case-insensitive "Bearer", single space, then the token.
  const m = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!m) return null;
  return m[1]!.trim();
}

/**
 * Pure auth + version resolve. Returns either a fully-populated
 * `ApiAuthContext` OR a NextResponse with the appropriate error.
 *
 * Side-effects (intentional):
 *   - Fires `bumpApiKeyLastUsed` fire-and-forget on success. Never blocks
 *     the request on the Firestore write.
 */
export async function authenticateApiRequest(
  request: Request,
): Promise<ApiAuthContext | AgencyApiAuthContext | NextResponse> {
  const requestId = newRequestId();
  // Always set a temporary meta with the latest version — if the header
  // says something invalid we want the rejection response to still echo a
  // sane LeadStack-Version header.
  const tentativeMeta: ResponseMeta = {
    requestId,
    apiVersion: LATEST_API_VERSION,
  };

  const token = readBearerToken(request);
  if (!token) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "missing_api_key",
      "No API key provided. Pass it via the Authorization header as 'Bearer <key>'.",
    );
  }

  const parsed = parseApiKey(token);
  if (!parsed) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "malformed_api_key",
      "The API key is malformed. Keys must look like 'lsk_live_<8>_<32>' or 'lsk_test_<8>_<32>'.",
    );
  }

  const candidate = await findApiKeyByPrefix(parsed.prefix);
  if (!candidate || candidate.mode !== parsed.mode) {
    // Unknown prefix OR mode mismatch (someone replaced "live" with "test"
    // in a captured key, hoping the prefix collides). Constant-message
    // either way so callers can't distinguish.
    return apiError(
      tentativeMeta,
      "authentication_error",
      "invalid_api_key",
      "Invalid API key provided.",
    );
  }

  // Constant-time hash comparison BEFORE the lastUsedAt bump so a timing
  // attacker can't tell whether a key exists.
  const expected = candidate.hashedSecret;
  const actual = hashApiKey(token);
  if (!safeEqualHash(expected, actual)) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "invalid_api_key",
      "Invalid API key provided.",
    );
  }

  if (candidate.revokedAt) {
    return apiError(
      tentativeMeta,
      "authentication_error",
      "revoked_api_key",
      "This API key has been revoked. Mint a new one from Settings → API keys.",
    );
  }

  const ownerRefusal =
    candidate.level === "agency"
      ? await agencyKeyRefusal(tentativeMeta, candidate)
      : await subAccountKeyRefusal(tentativeMeta, candidate.subAccountId);
  if (ownerRefusal) return ownerRefusal;

  // Resolve version. Caller pin (header) > key default > latest.
  const headerVersion = request.headers.get("leadstack-version");
  const resolved = resolveVersion({
    headerVersion: headerVersion ?? null,
    keyDefaultVersion: candidate.defaultVersion ?? null,
  });
  if ("error" in resolved) {
    return apiError(
      tentativeMeta,
      "invalid_request",
      "unsupported_version",
      resolved.error,
    );
  }

  // Best-effort lastUsedAt bump — never block on it.
  const owner: ApiKeyOwner =
    candidate.level === "agency"
      ? { level: "agency", agencyId: candidate.agencyId }
      : { level: "sub-account", subAccountId: candidate.subAccountId };
  void bumpApiKeyLastUsed(owner, candidate.id).catch((err) => {
    console.warn("[api/auth] bumpApiKeyLastUsed failed", err);
  });

  const fields: ApiAuthFields = {
    agencyId: candidate.agencyId,
    keyId: candidate.id,
    keyPrefix: candidate.prefix,
    keyName: candidate.name,
    mode: candidate.mode,
    scopes: candidate.scopes,
    enrolmentCapPerHour: resolveEnrolmentCapPerHour(candidate.enrolmentCapPerHour),
    requestId,
    apiVersion: resolved.version,
  };
  return candidate.level === "agency"
    ? { ...fields, level: "agency", subAccountId: null }
    : { ...fields, level: "sub-account", subAccountId: candidate.subAccountId };
}

/**
 * Sub-account key: the agency owner can flip `apiAccessEnabledByAgency` off
 * to immediately block every /api/v1/* request from a sub-account without
 * revoking individual keys. One extra Firestore read per request — well
 * worth it for the kill-switch capability. Default-deny on missing field
 * (legacy docs / first run).
 */
async function subAccountKeyRefusal(
  meta: ResponseMeta,
  subAccountId: string,
): Promise<NextResponse | null> {
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) {
    return apiError(
      meta,
      "authentication_error",
      "invalid_api_key",
      "Invalid API key provided.",
    );
  }
  if (subSnap.data()!.apiAccessEnabledByAgency !== true) {
    return apiError(
      meta,
      "permission_error",
      "api_access_disabled",
      "API access has been disabled for this sub-account by your agency administrator. Contact them to re-enable.",
    );
  }
  return null;
}

/**
 * Agency key, read fresh on every request: the agency's Agent API kill
 * switch (`agencies/{id}.agentApiEnabled`, default off) and the owner who
 * minted the key still being an active owner — one read of their
 * `agencyMembers` row, never the Auth Admin API.
 */
async function agencyKeyRefusal(
  meta: ResponseMeta,
  key: Extract<ApiKeyDoc, { level: "agency" }>,
): Promise<NextResponse | null> {
  const db = getAdminDb();
  const [agency, minter] = await Promise.all([
    db.doc(`agencies/${key.agencyId}`).get(),
    db.doc(`agencies/${key.agencyId}/agencyMembers/${key.createdByUid}`).get(),
  ]);
  if (!agency.exists) {
    return apiError(meta, "authentication_error", "invalid_api_key", "Invalid API key provided.");
  }
  if (agency.data()?.agentApiEnabled !== true) {
    return apiError(
      meta,
      "permission_error",
      "agent_api_disabled",
      "The Agent API is switched off for this agency. The agency owner can switch it on in Agency settings.",
    );
  }
  const member = minter.data();
  if (member?.role !== "owner" || member?.status !== "active") {
    return apiError(
      meta,
      "authentication_error",
      "minter_removed",
      "The agency owner who minted this key is no longer an active owner. Mint a new key.",
    );
  }
  return null;
}

/**
 * The refusal for an agency key on a transport that takes sub-account keys
 * only (every one, until the agency transports land). Logged under
 * `agencies/{id}/apiRequestLogs` — never under a sub-account — with no
 * request body.
 */
export function refuseAgencyKey(
  ctx: AgencyApiAuthContext,
  request: Request,
  start: number,
): NextResponse {
  const response = apiError(
    ctx,
    "permission_error",
    "agency_key_not_allowed",
    "This endpoint takes a sub-account API key. Agency keys are not accepted here.",
  );
  void captureRequestLog({
    subAccountId: null,
    agencyId: ctx.agencyId,
    keyId: ctx.keyId,
    keyPrefix: ctx.keyPrefix,
    mode: ctx.mode,
    requestId: ctx.requestId,
    method: request.method,
    path: new URL(request.url).pathname,
    query: "",
    requestHeaders: request.headers,
    requestBody: "",
    responseStatus: response.status,
    responseBodyJson: null,
    errorCode: "agency_key_not_allowed",
    latencyMs: Date.now() - start,
  });
  return response;
}

/**
 * Check a required scope against the resolved ctx. Returns a NextResponse
 * if access is denied; null otherwise. Routes that don't use the
 * `withApiAuth` HOF call this directly after `authenticateApiRequest`.
 */
export function requireApiScope(
  ctx: ApiAuthContext,
  scope: ApiKeyScope,
): NextResponse | null {
  if (ctx.scopes.includes(scope)) return null;
  return apiError(
    ctx,
    "permission_error",
    "insufficient_scope",
    `This key is missing required scope '${scope}'. Mint a new key with the right scope.`,
  );
}

/**
 * High-level wrapper. Use for nearly every v1 route handler — handles
 * auth, body parsing, scope check, idempotency, response headers.
 *
 * Usage:
 *   export const POST = withApiAuth<{ id: string }>(async (input) => {
 *     const { ctx, params, body } = input;
 *     // ... business logic
 *     return apiOk(ctx, { contact: serializeContactForApi(c) }, { status: 201 });
 *   }, { requireScope: "admin" });
 */
export function withApiAuth<P extends Record<string, string> = Record<string, string>>(
  handler: (input: ApiHandlerInput<P>) => Promise<NextResponse>,
  opts: WithApiAuthOptions = {},
): (
  request: Request,
  routeCtx: { params?: Promise<P> },
) => Promise<NextResponse> {
  const requireScope: ApiKeyScope = opts.requireScope ?? "admin";

  return async (request, routeCtx) => {
    const start = Date.now();
    const url = new URL(request.url);

    const ctxOrErr = await authenticateApiRequest(request);
    if (!isAuthContext(ctxOrErr)) {
      // Auth failed — no ctx, no log capture (we don't know which sub-account
      // to write under). The 401 response itself is the audit record.
      return ctxOrErr;
    }
    if (ctxOrErr.level === "agency") return refuseAgencyKey(ctxOrErr, request, start);
    const ctx = ctxOrErr;

    // Read the body BEFORE any other branching — every subsequent exit
    // point (scope-fail, rate-limit-fail, idempotency-replay, handler) needs
    // it in scope for the log capture. GET / HEAD short-circuit inside
    // readBody so this is essentially free for read paths.
    // Next passes `params: undefined` to a route with no dynamic segment.
    const params = (await routeCtx.params) ?? ({} as P);
    const maxBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    const { rawBody, body, tooLarge } = await readJsonBody(request, maxBytes);
    const redact = opts.redactLog?.(params) ?? { requestBody: false, responseBody: false };

    // Helper that captures the log + returns the response. Used at every
    // exit point so every request makes it into the log viewer regardless
    // of how it ended (success, error, rate-limited, idempotency replay).
    const finalize = async (
      response: NextResponse,
      preReadBody?: unknown,
      errorCode?: string | null,
    ): Promise<NextResponse> => {
      const bodyJson =
        preReadBody !== undefined
          ? preReadBody
          : await response
              .clone()
              .json()
              .catch(() => null);
      void captureRequestLog({
        subAccountId: ctx.subAccountId,
        agencyId: ctx.agencyId,
        keyId: ctx.keyId,
        keyPrefix: ctx.keyPrefix,
        mode: ctx.mode,
        requestId: ctx.requestId,
        method: request.method,
        path: url.pathname,
        query: redact.requestBody ? "" : url.search,
        requestHeaders: request.headers,
        requestBody: redact.requestBody ? "" : rawBody,
        responseStatus: response.status,
        responseBodyJson: redact.responseBody ? null : bodyJson,
        errorCode: errorCode ?? null,
        latencyMs: Date.now() - start,
      });
      return response;
    };

    if (tooLarge) return finalize(bodyTooLarge(ctx, maxBytes), undefined, "body_too_large");

    const scopeErr = requireApiScope(ctx, requireScope);
    if (scopeErr) return finalize(scopeErr, undefined, "insufficient_scope");

    // Rate limit. Runs AFTER auth + scope check — failed-auth requests don't
    // burn the legitimate caller's per-key budget.
    const rl = checkRateLimit({
      keyId: ctx.keyId,
      mode: ctx.mode,
      scope: requireScope,
    });
    if (!rl.ok) {
      const rlResp = apiError(
        ctx,
        "rate_limit_error",
        "rate_limited",
        `Too many requests. Retry after ${rl.retryAfterSec}s.`,
        {
          extraHeaders: {
            "Retry-After": String(rl.retryAfterSec),
            "X-RateLimit-Limit": String(rl.limit ?? 0),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(rl.retryAfterSec),
            "X-RateLimit-Window": rl.window ?? "",
          },
        },
      );
      return finalize(rlResp, undefined, "rate_limited");
    }

    // Route params become doc paths: refuse a non-doc id before any read.
    const badParam = opts.docIdParams === false ? null : invalidParam(ctx, params);
    if (badParam) return finalize(badParam, undefined, "invalid_id");

    if (opts.precheck) {
      let refused: NextResponse | null;
      try {
        refused = await opts.precheck(ctx);
      } catch (err) {
        // Same as a throwing handler: a logged, generic v1 internal_error —
        // never the raw error, never cached (the lookup hasn't run yet).
        console.error("[api/v1] precheck threw", err);
        return finalize(
          apiError(
            ctx,
            "internal_error",
            "internal_error",
            "Something went wrong on our end. Quote this request_id in support.",
          ),
          undefined,
          "internal_error",
        );
      }
      if (refused) {
        const code = await refused
          .clone()
          .json()
          .then((b: { error?: { code?: string } }) => b.error?.code ?? null)
          .catch(() => null);
        return finalize(refused, undefined, code);
      }
    }

    // Idempotency check (POST/PATCH/DELETE + header present).
    const idempotencyKey = request.headers.get("idempotency-key");
    const useIdempotency =
      opts.idempotency !== false &&
      METHODS_WITH_IDEMPOTENCY.has(request.method) &&
      !!idempotencyKey &&
      (opts.cacheIdempotently ? opts.cacheIdempotently(params) : true);

    const internalError = () =>
      finalize(
        apiError(
          ctx,
          "internal_error",
          "internal_error",
          "Something went wrong on our end. Quote this request_id in support.",
        ),
        undefined,
        "internal_error",
      );
    let reservation: Extract<IdempotencyReservation, { kind: "reserved" }> | null = null;
    if (useIdempotency) {
      if (!isValidIdempotencyKey(idempotencyKey!)) {
        return finalize(
          apiError(
            ctx,
            "invalid_request",
            "invalid_idempotency_key",
            "Idempotency-Key must be 1-255 characters of [A-Za-z0-9_-:.].",
          ),
          undefined,
          "invalid_idempotency_key",
        );
      }
      // Claim the key BEFORE the handler, so concurrent retries run it once.
      let found: IdempotencyReservation;
      try {
        found = await reserveIdempotencyKey(
          ctx.subAccountId,
          ctx.mode,
          ctx.keyId,
          idempotencyKey!,
          fingerprintRequest(request.method, url.pathname, rawBody),
        );
      } catch (err) {
        // Fail closed: without a reservation a retry could run twice.
        console.error("[api/v1] idempotency reservation failed", err);
        return internalError();
      }
      if (found.kind === "collision") {
        return finalize(
          apiError(
            ctx,
            "idempotency_error",
            "idempotency_collision",
            "This Idempotency-Key was already used with a different request body. Use a new key for a new request.",
          ),
          undefined,
          "idempotency_collision",
        );
      }
      if (found.kind === "in_progress") {
        return finalize(
          apiError(
            ctx,
            "idempotency_error",
            "idempotency_in_progress",
            "A request with this Idempotency-Key is still being processed. Retry shortly.",
            { extraHeaders: { "Retry-After": "1" } },
          ),
          undefined,
          "idempotency_in_progress",
        );
      }
      if (found.kind === "outcome_unknown") {
        return finalize(
          apiError(
            ctx,
            "idempotency_error",
            "outcome_unknown",
            "A previous request with this Idempotency-Key may have completed; check before retrying with a new key.",
          ),
          undefined,
          "outcome_unknown",
        );
      }
      if (found.kind === "replay") {
        return finalize(
          apiOk(ctx, found.cached.bodyJson, { status: found.cached.status }),
          found.cached.bodyJson,
        );
      }
      reservation = found;
    }
    /** Hand the key back so a retry runs; never fails the response. */
    const releaseReservation = async () => {
      try {
        await reservation?.release();
      } catch (err) {
        console.warn("[api/v1] idempotency reservation release failed", err);
      }
    };

    // Whatever throws from here on (the handler, a cacheIdempotently bug),
    // the reservation is settled: its heartbeat stops and, unless store or
    // release already ran, the key is handed back — or, once the handler has
    // returned (its action may have happened), marked done_unknown.
    let response: NextResponse | undefined;
    try {
      try {
        response = await handler({ request, params, body, rawBody, ctx });
      } catch (err) {
        console.error("[api/v1] handler threw", err);
        await releaseReservation();
        return internalError();
      }

      // Read response body ONCE, here, so both the idempotency cache writer
      // and the log capture see the same bytes without re-consuming the
      // response stream.
      const responseBodyJson = await response
        .clone()
        .json()
        .catch(() => null);

      // Cache outcomes only — never a server error, and never a 429: both
      // tell the caller to retry, and a retry with the same key must reach
      // the handler again rather than replay "try later" for 24h.
      // INVARIANT: a handler returns 429 only BEFORE any write or send (the
      // enrolment gate does). One returned after a side effect would be
      // repeated by the retry.
      const storeOutcome = opts.cacheIdempotently
        ? opts.cacheIdempotently(params, { status: response.status, body: responseBodyJson })
        : response.status < 500 && response.status !== 429;
      if (reservation && storeOutcome) {
        // Never throws: retries, then marks the key done_unknown (see store).
        await reservation.store({ status: response.status, bodyJson: responseBodyJson });
      } else if (reservation) {
        // Not a stored outcome (a 5xx, a 429, or the route vetoed it): free the
        // key so the caller's retry actually runs the handler again.
        await releaseReservation();
      }

      // Add per-key rate-limit snapshot headers so client libraries can pace
      // themselves without waiting for a 429. Computed AFTER the request was
      // counted so `remaining` reflects post-increment.
      const snapshot = snapshotRemaining({
        keyId: ctx.keyId,
        mode: ctx.mode,
        scope: requireScope,
      });
      response.headers.set("X-RateLimit-Limit", String(snapshot.limit));
      response.headers.set("X-RateLimit-Remaining", String(snapshot.remaining));
      response.headers.set("X-RateLimit-Reset", String(snapshot.resetSec));

      return finalize(response, responseBodyJson);
    } catch (err) {
      // A step after the handler threw (e.g. a cacheIdempotently bug). Answer
      // with the logged v1 500 rather than letting Next send a raw one; the
      // finally marks the key done_unknown, since the handler did return.
      console.error("[api/v1] post-handler step threw", err);
      return internalError();
    } finally {
      if (response) await reservation?.markUnknown();
      else await releaseReservation();
    }
  };
}

function isAuthContext(
  v: ApiAuthContext | AgencyApiAuthContext | NextResponse,
): v is ApiAuthContext | AgencyApiAuthContext {
  // NextResponse has `status` numbers; ApiAuthContext has a `keyId` string.
  // Cheapest discriminator.
  return typeof (v as ApiAuthContext).keyId === "string";
}
