import "server-only";

/**
 * Minimal Vercel REST client for the in-app setup form.
 *
 * Powers three things and nothing else:
 *   1. Reading the project's env-var KEY NAMES (never values) so the form can
 *      show what's already stored vs. still missing.
 *   2. Upserting env vars the agency owner submits.
 *   3. Triggering a redeploy so the new values take effect (Next bakes env at
 *      build time — a redeploy is mandatory, especially for NEXT_PUBLIC_*).
 *
 * All calls require `VERCEL_TOKEN` + `VERCEL_PROJECT_ID`; `VERCEL_TEAM_ID` is
 * only needed when the project lives under a Vercel team. The deploy hook is a
 * secret URL and needs no token. See docs/plans/setup-env-form.md.
 */

const API = "https://api.vercel.com";

export class VercelError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "VercelError";
    this.status = status;
  }
}

/**
 * Whether the preflight vars needed to talk to Vercel are present. This is the
 * env-derived boolean that ungrays the setup-form enable toggle. TEAM_ID is
 * intentionally NOT required — personal accounts don't have one.
 */
export function vercelConfigured(): boolean {
  return (
    !!process.env.VERCEL_TOKEN?.trim() &&
    !!process.env.VERCEL_PROJECT_ID?.trim() &&
    !!process.env.VERCEL_DEPLOY_HOOK_URL?.trim()
  );
}

/**
 * Domains-only readiness (funnel subdomains). Deliberately does NOT require
 * VERCEL_DEPLOY_HOOK_URL — attaching a domain needs no redeploy, and the
 * setup-form's stricter gate shouldn't block this feature.
 */
export function vercelDomainsConfigured(): boolean {
  return (
    !!process.env.VERCEL_TOKEN?.trim() && !!process.env.VERCEL_PROJECT_ID?.trim()
  );
}

/**
 * Register a hostname (e.g. `7dsummer.leadstack.dev`) on the project.
 *
 * With a wildcard CNAME already pointing `*.domain` at Vercel, this is the
 * ONLY per-subdomain step: DNS already resolves, so Vercel issues the
 * per-hostname certificate on its own within a minute or two. Subdomains of a
 * domain the project already owns need no extra verification.
 *
 * Idempotent for our purposes: Vercel returns 409 when the domain is already
 * on this project — treated as success, because the goal state is "attached".
 */
export async function addProjectDomain(hostname: string): Promise<void> {
  const { token, projectId, teamId } = requireConfig();
  const res = await fetch(
    url(`/v10/projects/${projectId}/domains`, teamId),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: hostname }),
    },
  );
  if (res.ok || res.status === 409) return;
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  throw new VercelError(
    body.error?.message ?? `Couldn't add ${hostname} (HTTP ${res.status})`,
    res.status,
  );
}

/** Detach a hostname from the project. Best-effort semantics at call sites —
 *  a leftover domain serves a 404 funnel, which is annoying but harmless. */
export async function removeProjectDomain(hostname: string): Promise<void> {
  const { token, projectId, teamId } = requireConfig();
  const res = await fetch(
    url(`/v9/projects/${projectId}/domains/${encodeURIComponent(hostname)}`, teamId),
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  // 404 = already gone. Goal state reached either way.
  if (res.ok || res.status === 404) return;
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  throw new VercelError(
    body.error?.message ?? `Couldn't remove ${hostname} (HTTP ${res.status})`,
    res.status,
  );
}

function requireConfig(): { token: string; projectId: string; teamId?: string } {
  const token = process.env.VERCEL_TOKEN?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) {
    throw new VercelError(
      "Vercel is not configured — set VERCEL_TOKEN + VERCEL_PROJECT_ID.",
    );
  }
  const teamId = process.env.VERCEL_TEAM_ID?.trim() || undefined;
  return { token, projectId, teamId };
}

function url(path: string, teamId?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  if (teamId) params.set("teamId", teamId);
  const qs = params.toString();
  return `${API}${path}${qs ? `?${qs}` : ""}`;
}

async function vercelFetch(
  path: string,
  init: RequestInit,
  teamId?: string,
  extra?: Record<string, string>,
): Promise<unknown> {
  const { token } = requireConfig();
  let res: Response;
  try {
    res = await fetch(url(path, teamId, extra), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      // Never cache credentialed control-plane calls.
      cache: "no-store",
    });
  } catch (e) {
    throw new VercelError(
      `Couldn't reach Vercel: ${(e as Error).message}`,
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body; leave null
  }
  if (!res.ok) {
    const errObj = json as { error?: { message?: string } } | null;
    const msg = errObj?.error?.message || text || res.statusText;
    throw new VercelError(`Vercel API ${res.status}: ${msg}`, res.status);
  }
  return json;
}

// ── env vars ─────────────────────────────────────────────────────────────────

interface VercelEnvEntry {
  id: string;
  key: string;
  target?: string[] | string;
  type?: string;
}

/**
 * List the project's env-var KEY NAMES + metadata. Deliberately does NOT
 * decrypt or return values — presence is all the form needs, and never
 * touching the secret keeps it off the wire. Returns a map keyed by var name.
 */
export async function listEnvKeys(): Promise<
  Map<string, { id: string; target: string[] }>
> {
  const { projectId, teamId } = requireConfig();
  const data = (await vercelFetch(
    `/v9/projects/${projectId}/env`,
    { method: "GET" },
    teamId,
    { decrypt: "false" },
  )) as { envs?: VercelEnvEntry[] };

  const out = new Map<string, { id: string; target: string[] }>();
  for (const e of data.envs ?? []) {
    if (!e.key || !e.id) continue;
    const target = Array.isArray(e.target)
      ? e.target
      : e.target
        ? [e.target]
        : [];
    // First entry per key wins; production entries are what we care about.
    if (!out.has(e.key)) out.set(e.key, { id: e.id, target });
  }
  return out;
}

export interface UpsertResult {
  key: string;
  ok: boolean;
  action?: "created" | "updated";
  error?: string;
}

/**
 * Create-or-update each var against the Production target. Existing keys are
 * PATCHed by id; new keys are POSTed. Keys the caller didn't submit are never
 * touched — nothing is ever deleted here.
 */
export async function upsertEnvVars(
  vars: { key: string; value: string }[],
): Promise<UpsertResult[]> {
  const { projectId, teamId } = requireConfig();
  const existing = await listEnvKeys();
  const results: UpsertResult[] = [];

  for (const { key, value } of vars) {
    try {
      const current = existing.get(key);
      if (current) {
        await vercelFetch(
          `/v10/projects/${projectId}/env/${current.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ value, target: ["production"] }),
          },
          teamId,
        );
        results.push({ key, ok: true, action: "updated" });
      } else {
        await vercelFetch(
          `/v10/projects/${projectId}/env`,
          {
            method: "POST",
            body: JSON.stringify({
              key,
              value,
              type: "encrypted",
              target: ["production"],
            }),
          },
          teamId,
        );
        results.push({ key, ok: true, action: "created" });
      }
    } catch (e) {
      results.push({ key, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

// ── deploy ───────────────────────────────────────────────────────────────────

/**
 * Fire the project's Deploy Hook to rebuild the production branch. The hook URL
 * is itself the credential (no token), so this posts to it directly.
 */
export async function triggerRedeploy(): Promise<{ ok: boolean; id?: string }> {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL?.trim();
  if (!hook) throw new VercelError("VERCEL_DEPLOY_HOOK_URL is not set.");
  let res: Response;
  try {
    res = await fetch(hook, { method: "POST", cache: "no-store" });
  } catch (e) {
    throw new VercelError(`Couldn't reach the deploy hook: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new VercelError(
      `Deploy hook returned ${res.status}: ${await res.text()}`,
      res.status,
    );
  }
  const json = (await res.json().catch(() => null)) as {
    job?: { id?: string };
  } | null;
  return { ok: true, id: json?.job?.id };
}

/**
 * Latest deployment's state, for the "we're rebuilding…" poller. Best-effort:
 * returns null rather than throwing so a status poll never hard-fails.
 */
export async function getLatestDeploymentState(): Promise<{
  id: string;
  state: string;
} | null> {
  try {
    const { projectId, teamId } = requireConfig();
    const data = (await vercelFetch(
      `/v6/deployments`,
      { method: "GET" },
      teamId,
      { projectId, limit: "1" },
    )) as {
      deployments?: { uid?: string; state?: string; readyState?: string }[];
    };
    const d = data.deployments?.[0];
    if (!d?.uid) return null;
    return { id: d.uid, state: d.state ?? d.readyState ?? "UNKNOWN" };
  } catch {
    return null;
  }
}
