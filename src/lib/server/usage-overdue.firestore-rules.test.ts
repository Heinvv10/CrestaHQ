import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken, rulesFetch } from "../../test/rules-api";

/**
 * The repo's OWN firestore.rules for the usage-billing flags, through the
 * Firebase Rules `projects:test` API: same harness and credential rule as
 * `src/lib/audit/audit-events.firestore-rules.test.ts` (skips locally without
 * FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * `subAccounts/{id}.usageOverdue` drives the client banner and paywall, so it
 * is member-READABLE (the control) and must be writable by no client at all:
 * not a collaborator, not the sub-account admin, not the agency owner. The
 * same holds for the agency's `usagePaywallEnabled`.
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

type Method = "get" | "create" | "update" | "delete";

interface Caller {
  uid: string;
  agencyRole: "owner" | "none";
  role?: "admin" | "collaborator";
}

const owner: Caller = { uid: "owner_a", agencyRole: "owner" };
const admin: Caller = { uid: "admin_1", agencyRole: "none", role: "admin" };
const collaborator: Caller = { uid: "collab_1", agencyRole: "none", role: "collaborator" };
const SUB = { agencyId: "agency_a", name: "Acme", usageOverdue: null };
const AGENCY = { name: "Agency A", usagePaywallEnabled: false };
const OVERDUE = { chargeId: "usage_sa_1_2026-09", amountCents: 5000, currency: "zar", usageMonth: "2026-09", paywall: true };

async function evaluate(
  cases: { caller: Caller; method: Method; path: string; data?: unknown }[],
): Promise<{ allowed: boolean; errors: string[] }[]> {
  const access_token = await rulesAccessToken(creds);
  const testCases = cases.map(({ caller, method, path, data }) => ({
    expectation: "ALLOW",
    request: {
      path: `${DOCS}${path}`,
      method,
      auth: {
        uid: caller.uid,
        token: { status: "active", agencyId: "agency_a", agencyRole: caller.agencyRole },
      },
      ...(method === "get" || method === "delete" ? {} : { resource: { data } }),
    },
    resource: { data: path.startsWith("agencies/") ? AGENCY : SUB },
    functionMocks: [
      {
        function: "get",
        args: [{ exactValue: `${DOCS}subAccounts/sa_1/subAccountMembers/${caller.uid}` }],
        result: { value: caller.role ? { data: { status: "active", role: caller.role } } : null },
      },
      {
        function: "get",
        args: [{ exactValue: `${DOCS}subAccounts/sa_1` }],
        result: { value: { data: SUB } },
      },
    ],
  }));
  const res = await rulesFetch(`https://firebaserules.googleapis.com/v1/projects/${creds.projectId}:test`, {
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

type Case = { caller: Caller; method: Method; path: string; data?: unknown };
const SA = "subAccounts/sa_1";
const AG = "agencies/agency_a";
const CASES: [string, Case, boolean][] = [
  ["control: collaborator reads the sub-account doc (and so usageOverdue)", { caller: collaborator, method: "get", path: SA }, true],
  ["control: agency owner reads the agency doc", { caller: owner, method: "get", path: AG }, true],
  ["collaborator cannot set usageOverdue", { caller: collaborator, method: "update", path: SA, data: { ...SUB, usageOverdue: OVERDUE } }, false],
  ["sub-account admin cannot set usageOverdue", { caller: admin, method: "update", path: SA, data: { ...SUB, usageOverdue: OVERDUE } }, false],
  ["agency owner cannot set usageOverdue", { caller: owner, method: "update", path: SA, data: { ...SUB, usageOverdue: OVERDUE } }, false],
  ["sub-account admin cannot clear usageOverdue", { caller: admin, method: "update", path: SA, data: { ...SUB, usageOverdue: null } }, false],
  ["agency owner cannot set usagePaywallEnabled", { caller: owner, method: "update", path: AG, data: { ...AGENCY, usagePaywallEnabled: true } }, false],
  ["sub-account admin cannot set usagePaywallEnabled", { caller: admin, method: "update", path: AG, data: { ...AGENCY, usagePaywallEnabled: true } }, false],
];

describe.skipIf(!haveCreds)("usage overdue flag and paywall setting — firestore rules", () => {
  let results: { allowed: boolean; errors: string[] }[] = [];

  beforeAll(async () => {
    results = await evaluate(CASES.map(([, c]) => c));
  }, 30_000);

  it.each(CASES.map(([name, , allow], i) => [name, allow, i] as const))("%s", (_name, allow, i) => {
    // A rules crash also denies; require a clean evaluation so a deny here is
    // the rule saying no, not a broken set-up.
    expect(results[i].errors).toEqual([]);
    expect(results[i].allowed).toBe(allow);
  });
});
