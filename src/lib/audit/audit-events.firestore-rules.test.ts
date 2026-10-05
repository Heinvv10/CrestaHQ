import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken } from "../../test/rules-token";

/**
 * Evaluates the repo's OWN firestore.rules — this file, not what is deployed —
 * through the Firebase Rules `projects:test` API. Nothing is deployed and no
 * data is read: the API evaluates the source against mocked requests, with
 * each `get()` of a membership doc answered from `functionMocks`.
 *
 * Runs under `pnpm test:rules` (vitest.rules.config.mts), not `pnpm test`, so
 * the Admin credential it needs is scoped to one CI step. Without that
 * credential it skips locally and FAILS in CI — a rules gate that silently
 * stopped running would be worse than none.
 *
 * A rules crash (an unmocked get(), a missing claim) also denies. Every case
 * therefore asserts the evaluation raised no error, so a "denied" here means
 * the rule said no — not that the test set-up broke it. The one exception is
 * "deny: not a member": get() of a membership doc that does not exist returns
 * null and `.data` on it is a Null value error — the path a non-member takes
 * in production — so that outcome requires exactly that error and no other.
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

type Method = "get" | "list" | "create" | "update" | "delete";

interface Caller {
  uid: string;
  agencyId: string;
  agencyRole: "owner" | "none";
  status?: string;
  /**
   * Sub-account membership docs the rules may get(). null = no such doc,
   * which get() returns as null in production too.
   */
  memberships?: Record<string, { status: string; role: string } | null>;
}

interface Case {
  caller: Caller | null;
  method: Method;
  doc: { agencyId: string; subAccountId: string | null };
}

async function evaluate(cases: Case[]): Promise<{ allowed: boolean; errors: string[] }[]> {
  const access_token = await rulesAccessToken(creds);
  const testCases = cases.map(({ caller, method, doc }) => ({
    expectation: "ALLOW",
    request: {
      path: `${DOCS}auditEvents/evt_1`,
      method,
      auth: caller
        ? {
            uid: caller.uid,
            token: {
              status: caller.status ?? "active",
              agencyId: caller.agencyId,
              agencyRole: caller.agencyRole,
            },
          }
        : null,
      ...(method === "create" || method === "update" ? { resource: { data: doc } } : {}),
    },
    resource: method === "create" ? null : { data: doc },
    functionMocks: Object.entries(caller?.memberships ?? {}).map(([saId, data]) => ({
      function: "get",
      args: [{ exactValue: `${DOCS}subAccounts/${saId}/subAccountMembers/${caller!.uid}` }],
      result: { value: data === null ? null : { data } },
    })),
  }));

  const res = await fetch(
    `https://firebaserules.googleapis.com/v1/projects/${creds.projectId}:test`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        source: { files: [{ name: "firestore.rules", content: RULES }] },
        testSuite: { testCases },
      }),
    }
  );
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

const SA_EVENT = { agencyId: "agency_a", subAccountId: "sa_1" };
const AGENCY_EVENT = { agencyId: "agency_a", subAccountId: null };

const owner: Caller = { uid: "owner_a", agencyId: "agency_a", agencyRole: "owner" };
const otherOwner: Caller = {
  uid: "owner_b",
  agencyId: "agency_b",
  agencyRole: "owner",
  memberships: { sa_1: null },
};
const saAdmin: Caller = {
  uid: "admin_1",
  agencyId: "agency_a",
  agencyRole: "none",
  memberships: { sa_1: { status: "active", role: "admin" } },
};
const otherSaAdmin: Caller = {
  uid: "admin_2",
  agencyId: "agency_a",
  agencyRole: "none",
  memberships: { sa_1: null, sa_2: { status: "active", role: "admin" } },
};
const removedAdmin: Caller = {
  uid: "admin_3",
  agencyId: "agency_a",
  agencyRole: "none",
  memberships: { sa_1: { status: "removed", role: "admin" } },
};
const collaborator: Caller = {
  uid: "collab_1",
  agencyId: "agency_a",
  agencyRole: "none",
  memberships: { sa_1: { status: "active", role: "collaborator" } },
};

type Outcome = "allow" | "deny" | "deny: not a member";

const CASES: [string, Case, Outcome][] = [
  ["agency owner reads a sub-account event in their agency", { caller: owner, method: "get", doc: SA_EVENT }, "allow"],
  ["agency owner reads an agency-level event", { caller: owner, method: "get", doc: AGENCY_EVENT }, "allow"],
  ["sub-account admin reads their sub-account's event", { caller: saAdmin, method: "get", doc: SA_EVENT }, "allow"],
  ["sub-account admin lists their sub-account's events", { caller: saAdmin, method: "list", doc: SA_EVENT }, "allow"],
  ["another agency's owner is denied (cross-tenant)", { caller: otherOwner, method: "get", doc: SA_EVENT }, "deny: not a member"],
  ["another sub-account's admin is denied (cross-tenant)", { caller: otherSaAdmin, method: "get", doc: SA_EVENT }, "deny: not a member"],
  ["a removed sub-account admin is denied", { caller: removedAdmin, method: "get", doc: SA_EVENT }, "deny"],
  ["a collaborator is denied", { caller: collaborator, method: "get", doc: SA_EVENT }, "deny"],
  ["a sub-account admin is denied an agency-level event", { caller: saAdmin, method: "get", doc: AGENCY_EVENT }, "deny"],
  ["a suspended owner is denied", { caller: { ...owner, status: "removed" }, method: "get", doc: SA_EVENT }, "deny"],
  ["signed-out is denied", { caller: null, method: "get", doc: SA_EVENT }, "deny"],
  ["agency owner cannot create (client write)", { caller: owner, method: "create", doc: SA_EVENT }, "deny"],
  ["agency owner cannot update (append-only)", { caller: owner, method: "update", doc: SA_EVENT }, "deny"],
  ["agency owner cannot delete (append-only)", { caller: owner, method: "delete", doc: SA_EVENT }, "deny"],
  ["sub-account admin cannot create (client write)", { caller: saAdmin, method: "create", doc: SA_EVENT }, "deny"],
];

describe.skipIf(!haveCreds)("auditEvents firestore rules", () => {
  let results: { allowed: boolean; errors: string[] }[] = [];

  beforeAll(async () => {
    results = await evaluate(CASES.map(([, c]) => c));
  }, 30_000);

  it.each(CASES.map(([name, , outcome], i) => [name, outcome, i] as const))(
    "%s",
    (_name, outcome, i) => {
      const { allowed, errors } = results[i];
      if (outcome === "deny: not a member") {
        expect(errors.length).toBeGreaterThan(0);
        for (const e of errors) expect(e).toMatch(/Null value error/);
      } else {
        expect(errors).toEqual([]);
      }
      expect(allowed).toBe(outcome === "allow");
    }
  );
});
