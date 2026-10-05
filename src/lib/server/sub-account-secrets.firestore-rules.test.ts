import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken, rulesFetch } from "../../test/rules-api";

import { SUB_ACCOUNT_SECRETS, subAccountSecretPath } from "../../types/sub-account-secrets";

/**
 * The repo's OWN firestore.rules for the integration-credential docs, through
 * the Firebase Rules `projects:test` API — same harness and credential rule as
 * `src/lib/audit/audit-events.firestore-rules.test.ts` (skips locally without
 * FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * What must hold: the parent `subAccounts/{id}` doc is readable by every
 * active member (the control — it is WHY the secrets cannot live there), and
 * no client at all — collaborator, sub-account admin, agency owner — may read
 * or write `subAccounts/{id}/private/*` where the tokens now live.
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

type Method = "get" | "create" | "update";

interface Caller {
  uid: string;
  agencyRole: "owner" | "none";
  role?: "admin" | "collaborator";
}

const owner: Caller = { uid: "owner_a", agencyRole: "owner" };
const admin: Caller = { uid: "admin_1", agencyRole: "none", role: "admin" };
const collaborator: Caller = { uid: "collab_1", agencyRole: "none", role: "collaborator" };
const SUB = { agencyId: "agency_a", name: "Acme" };

async function evaluate(
  cases: { caller: Caller; method: Method; path: string }[],
): Promise<{ allowed: boolean; errors: string[] }[]> {
  const access_token = await rulesAccessToken(creds);
  const testCases = cases.map(({ caller, method, path }) => ({
    expectation: "ALLOW",
    request: {
      path: `${DOCS}${path}`,
      method,
      auth: {
        uid: caller.uid,
        token: { status: "active", agencyId: "agency_a", agencyRole: caller.agencyRole },
      },
      ...(method === "get" ? {} : { resource: { data: { authToken: "x" } } }),
    },
    resource: method === "create" ? null : { data: path.includes("/private/") ? { authToken: "x" } : SUB },
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

const CASES: [string, { caller: Caller; method: Method; path: string }, boolean][] = [
  ["control: collaborator reads the sub-account doc", { caller: collaborator, method: "get", path: "subAccounts/sa_1" }, true],
  ["control: agency owner reads the sub-account doc", { caller: owner, method: "get", path: "subAccounts/sa_1" }, true],
];
for (const kind of Object.keys(SUB_ACCOUNT_SECRETS) as (keyof typeof SUB_ACCOUNT_SECRETS)[]) {
  const path = subAccountSecretPath("sa_1", kind);
  CASES.push(
    [`${kind}: collaborator cannot read`, { caller: collaborator, method: "get", path }, false],
    [`${kind}: sub-account admin cannot read`, { caller: admin, method: "get", path }, false],
    [`${kind}: agency owner cannot read`, { caller: owner, method: "get", path }, false],
    [`${kind}: sub-account admin cannot write`, { caller: admin, method: "create", path }, false],
    [`${kind}: agency owner cannot overwrite`, { caller: owner, method: "update", path }, false],
  );
}

describe.skipIf(!haveCreds)("integration credentials — firestore rules", () => {
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
