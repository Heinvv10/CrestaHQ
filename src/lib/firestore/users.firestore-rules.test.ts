import { readFileSync } from "node:fs";
import { cert } from "firebase-admin/app";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The repo's OWN firestore.rules for `users/{uid}`, through the Firebase Rules
 * `projects:test` API — same harness and credential rule as
 * `src/lib/audit/audit-events.firestore-rules.test.ts` (skips locally without
 * FIREBASE_ADMIN_*, FAILS in CI without them). Nothing is deployed.
 *
 * What must hold: a user may edit their own display profile (the /me/settings
 * page writes displayName + updatedAt), but never the fields
 * /api/auth/refresh-claims turns into custom claims (role, status,
 * primaryAgencyId) or the legacy billing fields — those are server-only.
 */

const creds = {
  projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
  clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};
const haveCreds = Boolean(creds.projectId && creds.clientEmail && creds.privateKey);
if (!haveCreds && process.env.CI) {
  throw new Error("FIREBASE_ADMIN_* credentials are required to run the rules tests in CI");
}

const DOCS = "/databases/(default)/documents/";
const RULES = readFileSync(new URL("../../../firestore.rules", import.meta.url), "utf8");

const CURRENT = {
  uid: "u_1",
  email: "u1@example.com",
  displayName: "Old",
  photoURL: null,
  stripeCustomerId: null,
  subscriptionStatus: "none",
  subscriptionPriceId: null,
  role: "collaborator",
  status: "removed",
  primaryAgencyId: "agency_a",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

interface Case {
  uid: string;
  method: "get" | "update";
  patch?: Record<string, unknown>;
}

async function evaluate(cases: Case[]): Promise<{ allowed: boolean; errors: string[] }[]> {
  const { access_token } = await cert(creds as Required<typeof creds>).getAccessToken();
  const testCases = cases.map(({ uid, method, patch }) => ({
    expectation: "ALLOW",
    request: {
      path: `${DOCS}users/u_1`,
      method,
      auth: { uid, token: { status: "active", agencyId: "agency_a", agencyRole: "none" } },
      ...(method === "update" ? { resource: { data: { ...CURRENT, ...patch } } } : {}),
    },
    resource: { data: CURRENT },
  }));
  const res = await fetch(`https://firebaserules.googleapis.com/v1/projects/${creds.projectId}:test`, {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      source: { files: [{ name: "firestore.rules", content: RULES }] },
      testSuite: { testCases },
    }),
  });
  const body = (await res.json()) as {
    testResults?: { state: string; debugMessages?: string[] }[];
    error?: unknown;
  };
  if (!res.ok || !body.testResults) {
    throw new Error(`rules test API ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.testResults.map((r) => ({
    allowed: r.state === "SUCCESS",
    errors: (r.debugMessages ?? []).filter((m) => m.includes("Error")),
  }));
}

const NOW = "2026-09-23T00:00:00Z";

const CASES: [string, Case, boolean][] = [
  ["self reads own profile", { uid: "u_1", method: "get" }, true],
  ["self updates displayName (the /me/settings write)", { uid: "u_1", method: "update", patch: { displayName: "New", updatedAt: NOW } }, true],
  ["self updates photoURL", { uid: "u_1", method: "update", patch: { photoURL: "https://x/y.png", updatedAt: NOW } }, true],
  ["self cannot set role", { uid: "u_1", method: "update", patch: { role: "admin" } }, false],
  ["self cannot reactivate status", { uid: "u_1", method: "update", patch: { status: "active" } }, false],
  ["self cannot change primaryAgencyId", { uid: "u_1", method: "update", patch: { primaryAgencyId: "agency_b" } }, false],
  ["self cannot add an unknown field", { uid: "u_1", method: "update", patch: { agencyRole: "owner" } }, false],
  ["self cannot change billing fields", { uid: "u_1", method: "update", patch: { subscriptionStatus: "active" } }, false],
  ["self cannot sneak role in with a name change", { uid: "u_1", method: "update", patch: { displayName: "New", role: "admin" } }, false],
  ["another user cannot update the profile", { uid: "u_2", method: "update", patch: { displayName: "Pwned" } }, false],
];

describe.skipIf(!haveCreds)("users/{uid} firestore rules", () => {
  let results: { allowed: boolean; errors: string[] }[] = [];

  beforeAll(async () => {
    results = await evaluate(CASES.map(([, c]) => c));
  }, 30_000);

  it.each(CASES.map(([name, , allow], i) => [name, allow, i] as const))("%s", (_name, allow, i) => {
    expect(results[i].errors).toEqual([]);
    expect(results[i].allowed).toBe(allow);
  });
});
