/**
 * Environment contract for the E2E suite. Every variable below is required —
 * the suite talks to real Firebase and a real fixture tenant, and a half-set
 * environment produces confusing mid-run failures rather than an obvious one.
 *
 * Reports ALL missing names at once. Finding out about the second missing
 * secret only after setting the first is how a five-minute fix becomes five
 * round trips through CI.
 */

const REQUIRED = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "FIREBASE_ADMIN_PROJECT_ID",
  "FIREBASE_ADMIN_CLIENT_EMAIL",
  "FIREBASE_ADMIN_PRIVATE_KEY",
  "E2E_EMAIL",
  "E2E_PASSWORD",
  "E2E_AGENCY_ID",
  "E2E_SUBACCOUNT_ID",
  "E2E_SUBACCOUNT_ID_SECONDARY",
] as const;

type RequiredName = (typeof REQUIRED)[number];

export type E2eEnv = Record<RequiredName, string>;

/**
 * Fixture sub-account names. These MUST match the names written by
 * scripts/e2e-provision.mjs — global setup aborts the run when they diverge,
 * which is the guard against pointing the suite at a real client tenant.
 */
export const FIXTURE_PRIMARY_NAME = "E2E Fixture Primary";
export const FIXTURE_SECONDARY_NAME = "E2E Fixture Secondary";

let _cached: E2eEnv | null = null;

export function readEnv(): E2eEnv {
  if (_cached) return _cached;

  const missing: string[] = [];
  const out = {} as E2eEnv;
  for (const name of REQUIRED) {
    const value = process.env[name];
    if (!value || !value.trim()) {
      missing.push(name);
      continue;
    }
    out[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `E2E environment is incomplete. Missing: ${missing.join(", ")}`,
    );
  }

  // GitHub secrets and .env files both carry the admin key with literal
  // "\n" escapes — same unescaping scripts/lookup-purchase.mjs does.
  out.FIREBASE_ADMIN_PRIVATE_KEY = out.FIREBASE_ADMIN_PRIVATE_KEY.replace(
    /\\n/g,
    "\n",
  );

  _cached = out;
  return out;
}

/**
 * The target the suite drives. Unset = the PR's own build, started by
 * Playwright's `webServer`; set = an already-running deployment (the
 * non-blocking smoke job points it at crm.crestahq.com).
 */
export const DEFAULT_BASE_URL = "http://127.0.0.1:3100";

export function baseURL(): string {
  return process.env.PLAYWRIGHT_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * QStash's signing key is NOT in REQUIRED: only the enrol spec needs it, and
 * putting it in the global contract would abort all five specs in global setup
 * on a deployment that has no QStash configured. It is demanded at the point
 * of use instead, so the other four keep their coverage.
 */
export function requireQStashSigningKey(): string {
  const value = process.env.QSTASH_CURRENT_SIGNING_KEY;
  if (!value || !value.trim()) {
    throw new Error(
      "QSTASH_CURRENT_SIGNING_KEY is not set, so the step worker cannot be " +
        "driven. Workflow execution is unprovable without it.",
    );
  }
  return value;
}

/** Where global setup parks the agency-owner session for the specs. */
export const STORAGE_STATE = "e2e/.auth/owner.json";
