import "server-only";

/**
 * wa-manager client — the CRM's server-side seam onto the fleet supervisor that
 * provisions, pairs, bounces and destroys one wa-agent-bridge process per
 * customer (services/wa-manager is the Go process on the other end).
 *
 * SECURITY — read this before adding a caller.
 *
 * The manager has ONE global operator token and no concept of tenant
 * ownership. That token can link a WhatsApp device on ANY tenant on the box
 * (see services/wa-manager/api/server.go: `authed` admits exactly one token,
 * and every handler acts on whatever id the path names). The manager tenant id
 * IS the CRM `subAccountId`, so the CRM — not the manager — is the tenancy
 * boundary.
 *
 * Every function here therefore takes an explicit `tenantId`, and **every
 * caller must derive it from the authenticated session's sub-account**, never
 * from a request body or query parameter. A route that forwards a caller-named
 * tenant id is a cross-tenant device-linking hole, not a validation bug.
 *
 * Nothing here logs the operator token, a pairing code, or a per-tenant bridge
 * credential. A pairing code links a device to the customer's number with
 * every permission that number has: it is a write-grade credential and is
 * handled exactly like one.
 *
 * Like `bridge-client`, no function throws. The manager being absent (a buyer
 * copy, a dev machine) or unreachable is an ANSWER the caller renders, not an
 * exception — importing this module must never require the env vars to exist.
 */

/** How long any one manager call may take. The manager's own on-demand health
 *  sweep is budgeted at 8s (api.SnapshotBudget) and the list route runs it
 *  synchronously, so a shorter timeout here would abandon a healthy response
 *  mid-sweep. */
const TIMEOUT_MS = 15_000;

/** One sentence, one copy: every route answers a manager-less deployment the
 *  same way, and `managerFailureResponse` turns it into the same 503. */
const NOT_CONFIGURED =
  "The WhatsApp bridge manager isn't configured on this deployment. Set WA_MANAGER_BASE_URL and WA_MANAGER_OPERATOR_TOKEN, or connect a bridge manually.";

export interface ManagerConfig {
  baseUrl: string;
  token: string;
}

/**
 * Config from env, or null when the manager is not configured.
 *
 * Trimmed, and blank treated as missing, for the same reason
 * `bridge-credentials.resolveBridgeCreds` does it: these values are pasted
 * from a terminal or read out of an `.env` file that carries a trailing
 * newline, and a newline on the end of a bearer token turns it into a 401 that
 * reads exactly like a revocation.
 *
 * `env` is a parameter rather than a direct `process.env` read so this stays
 * testable without mutating the process, and so nothing here is evaluated at
 * module load.
 */
export function resolveManagerConfig(
  env: Record<string, string | undefined> = process.env,
): ManagerConfig | null {
  const baseUrl = env.WA_MANAGER_BASE_URL?.trim();
  const token = env.WA_MANAGER_OPERATOR_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Trailing slashes stripped so call sites can concatenate "/api/tenants"
  // without producing a double slash the Go mux does not route.
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/**
 * Every manager call answers with one of these. A failure is data rather than
 * a thrown error because the callers are route handlers that must turn it into
 * a status and a sentence, and because `reason` carries distinctions the HTTP
 * status alone cannot:
 *
 *   not_configured — no manager on this deployment. Not an outage.
 *   unreachable    — the request never got an answer.
 *   conflict       — the manager AUTHORED a refusal (409): this tenant exists.
 *   refused        — any other non-2xx.
 */
export type ManagerFailureReason =
  | "not_configured"
  | "unreachable"
  | "conflict"
  | "refused";

export type ManagerResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ManagerFailureReason; error: string; status?: number };

/** The manager's `tenantView` projection. Carries no credential — by design;
 *  see the comment on that struct. */
export interface ManagerTenant {
  tenantId: string;
  displayName: string;
  instance: string;
  port: number;
  state: string;
  phone?: string;
}

/**
 * The 201 of a provision: the tenant projection plus the app consumer's
 * freshly minted credentials.
 *
 * This is the ONLY moment those two values are obtainable. The manager keeps
 * no readable copy (they live in the bridge instance's `.env`, which the CRM
 * cannot read), and there is no rotation route. A caller that drops them must
 * destroy and re-provision, which costs the customer a re-pair — so store them
 * before answering the request.
 *
 * `webhookSecret` is absent when the manager provisions unsigned tenants (no
 * webhook-secret generator configured). Absent is not the same as blank.
 */
export interface ProvisionedTenant extends ManagerTenant {
  token: string;
  webhookSecret?: string;
}

/**
 * Live pairing state for one tenant.
 *
 * `code` and `expiresAt` are ABSENT — not empty — when no pairing round is in
 * flight; the manager only emits them when `pairing` is true (see
 * services/wa-manager/api/pair.go). They are optional here rather than
 * defaulted to "" because "" would render as a QR of nothing, and a caller
 * cannot tell a blank code from a missing one.
 */
export interface PairingState {
  pairing: boolean;
  connected: boolean;
  code?: string;
  expiresAt?: string;
}

/**
 * One manager request. Never throws, never logs a body: a manager error body
 * is written for an operator on the box, and the pairing response embeds a
 * write-grade credential.
 */
async function call<T>(
  path: string,
  init: RequestInit,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> },
): Promise<ManagerResult<T>> {
  const cfg = resolveManagerConfig(opts.env);
  if (!cfg) {
    return {
      ok: false,
      reason: "not_configured",
      error: NOT_CONFIGURED,
    };
  }
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  let raw: string;
  try {
    res = await doFetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${cfg.token}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    raw = await res.text().catch(() => "");
  } catch {
    // The thrown error carries the request URL, and a misconfigured base URL
    // can have a credential in it. Report the fact, not the error.
    return {
      ok: false,
      reason: "unreachable",
      error: "Couldn't reach the WhatsApp bridge manager.",
    };
  }

  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    // The manager's own message is safe to relay: its handlers deliberately
    // return authored sentences and log the real error (paths, systemctl
    // stderr) on the box instead. Falling back to a generic sentence rather
    // than the raw body, which for a non-manager responder could be anything.
    const detail =
      typeof (body as { error?: unknown } | null)?.error === "string"
        ? (body as { error: string }).error
        : `the manager answered ${res.status}`;
    return {
      ok: false,
      reason: res.status === 409 ? "conflict" : "refused",
      error: detail,
      status: res.status,
    };
  }

  return { ok: true, data: body as T };
}

/**
 * Provision a bridge for one tenant.
 *
 * `tenantId` MUST be the session's sub-account id — see the security note at
 * the top of this file. 409 comes back as `reason: "conflict"`: the tenant
 * already exists, which for a caller that has no stored credentials means
 * destroy-and-reprovision, not retry.
 */
export function provisionTenant(
  tenantId: string,
  displayName: string,
  opts: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ManagerResult<ProvisionedTenant>> {
  return call<ProvisionedTenant>(
    "/api/tenants",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, displayName }),
    },
    opts,
  );
}

/** Live pairing state. The `code` is a write-grade credential — never log it. */
export function getPairing(
  tenantId: string,
  opts: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ManagerResult<PairingState>> {
  return call<PairingState>(
    `/api/tenants/${encodeURIComponent(tenantId)}/pair`,
    { method: "GET" },
    opts,
  );
}

/**
 * Bounce a tenant's bridge.
 *
 * This is how a fresh batch of pairing codes is obtained: the bridge has no
 * re-pair endpoint of its own, and a logged-out session only issues a code on
 * a fresh start.
 */
export function restartTenant(
  tenantId: string,
  opts: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ManagerResult<{ ok: boolean }>> {
  return call<{ ok: boolean }>(
    `/api/tenants/${encodeURIComponent(tenantId)}/restart`,
    { method: "POST" },
    opts,
  );
}

/**
 * Destroy a tenant: unit, files, WhatsApp session and port.
 *
 * `?confirm=<same id>` is REQUIRED — the manager returns 400 without it,
 * saying that erasing a WhatsApp session is irreversible (handleDelete). It is
 * passed explicitly rather than being made optional: the confirmation exists
 * because the operator token proves who is calling and not that they meant
 * THIS tenant, and a caller that could omit it would erase the guard for
 * everything downstream of this seam. The id is sent twice on purpose.
 */
export function destroyTenant(
  tenantId: string,
  opts: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ManagerResult<{ ok: boolean }>> {
  const id = encodeURIComponent(tenantId);
  return call<{ ok: boolean }>(
    `/api/tenants/${id}?confirm=${id}`,
    { method: "DELETE" },
    opts,
  );
}

/**
 * The pairing QR as a PNG, rendered by the manager.
 *
 * THIS IS THE ONLY WAY A PAIRING CODE MAY REACH A BROWSER. The code is a
 * write-grade credential — whoever scans it can send as that number — and the
 * admin holding the phone is nevertheless the only person who can complete a
 * pairing, so something has to cross. An image is what crosses: the payload is
 * encoded into pixels the manager drew, so it never exists as a string in a
 * JSON body, a React prop, a devtools network tab, a `localStorage` write or a
 * copy-paste into a support ticket. `getPairing` above deliberately does not
 * hand `code` to any route.
 *
 * It does NOT go through `call`, because `call` parses JSON and this answers
 * with bytes. The error body is never read at all: the manager writes plain
 * operator prose here, not JSON, and this seam authors its own sentences from
 * the status rather than relaying an unparsed body of unknown provenance.
 *
 * The manager's qr.png route sits behind `authedUI`, which accepts the
 * operator token as a bearer exactly like the JSON API — its Basic arm exists
 * only because a browser cannot put a header on an `<img src>`. This is a
 * server-to-server call, so the bearer is used.
 */
export async function getPairingQrPng(
  tenantId: string,
  opts: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ManagerResult<ArrayBuffer>> {
  const cfg = resolveManagerConfig(opts.env);
  if (!cfg) {
    return { ok: false, reason: "not_configured", error: NOT_CONFIGURED };
  }
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  let png: ArrayBuffer;
  try {
    res = await doFetch(
      `${cfg.baseUrl}/tenants/${encodeURIComponent(tenantId)}/qr.png`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    png = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0);
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      error: "Couldn't reach the WhatsApp bridge manager.",
    };
  }

  if (!res.ok) {
    // 409 is the manager saying this bridge is not offering a code right now —
    // it is connected already, or it has issued its handful and needs a
    // restart. That is a state the screen renders, not an outage, and it is
    // the one the caller most needs to tell apart.
    return {
      ok: false,
      reason: res.status === 409 ? "conflict" : "refused",
      error:
        res.status === 409
          ? "This number isn't waiting to be paired right now. Get a new code and try again."
          : "No pairing code is available for this workspace yet.",
      status: res.status,
    };
  }

  return { ok: true, data: png };
}
