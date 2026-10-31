import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken, rulesFetch } from "../../test/rules-api";

/**
 * The repo's OWN firestore.rules for `entitlements/{orderId}_{productId}`,
 * evaluated through the Firebase Rules `projects:test` API — same harness and
 * credential rule as `src/lib/paystack/payments.firestore-rules.test.ts`
 * (skips locally without FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * What must hold: members of the doc's sub-account (and its agency owner)
 * read it; nobody else does; NO client writes. The doc is the record that a
 * paid order already delivered, so a browser that could create, revoke or
 * delete one could forge a delivery or let a replay deliver twice.
 *
 * Every allow/deny pair differs only in the caller or the method under test.
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
type Data = Record<string, unknown>;

interface Caller {
  uid: string;
  agencyId: string;
  agencyRole: "owner" | "none";
  memberships?: Record<string, { status: string; role: string } | null>;
}

interface Case {
  caller: Caller | null;
  method: Method;
  path: string;
  before?: Data;
  after?: Data;
}

async function evaluate(cases: Case[]): Promise<{ allowed: boolean; errors: string[] }[]> {
  const access_token = await rulesAccessToken(creds);
  const testCases = cases.map(({ caller, method, path, before, after }) => ({
    expectation: "ALLOW",
    request: {
      path: `${DOCS}${path}`,
      method,
      auth: caller
        ? { uid: caller.uid, token: { status: "active", agencyId: caller.agencyId, agencyRole: caller.agencyRole } }
        : null,
      ...(after ? { resource: { data: after } } : {}),
    },
    resource: before ? { data: before } : null,
    functionMocks: Object.entries(caller?.memberships ?? {}).map(([saId, data]) => ({
      function: "get",
      args: [{ exactValue: `${DOCS}subAccounts/${saId}/subAccountMembers/${caller!.uid}` }],
      result: { value: data === null ? null : { data } },
    })),
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

const owner: Caller = { uid: "owner_a", agencyId: "agency_a", agencyRole: "owner" };
const saAdmin: Caller = {
  uid: "admin_1",
  agencyId: "agency_a",
  agencyRole: "none",
  memberships: { sa_1: { status: "active", role: "admin" } },
};
const collaborator: Caller = {
  uid: "collab_1",
  agencyId: "agency_a",
  agencyRole: "none",
  memberships: { sa_1: { status: "active", role: "collaborator" } },
};
const otherSaAdmin: Caller = {
  uid: "admin_2",
  agencyId: "agency_a",
  agencyRole: "none",
  memberships: { sa_1: null, sa_2: { status: "active", role: "admin" } },
};

const ENTITLEMENT = {
  agencyId: "agency_a",
  subAccountId: "sa_1",
  contactId: "c1",
  buyerEmail: "buyer@example.com",
  orderId: "ord1",
  productId: "p1",
  productName: "Fibre guide",
  delivery: { type: "download", url: "https://files.example.com/guide.pdf", label: "Get it" },
  status: "active",
  fulfilment: { state: "done", error: null, at: 1 },
  sends: 1,
  livemode: false,
};
const REVOKED = { ...ENTITLEMENT, status: "revoked" };

type Outcome = "allow" | "deny" | "deny: not a member";

const ENT = "entitlements/ord1_p1";

const CASES: [string, Case, Outcome][] = [
  ["sub-account admin reads", { caller: saAdmin, method: "get", path: ENT, before: ENTITLEMENT }, "allow"],
  ["sub-account admin lists", { caller: saAdmin, method: "list", path: ENT, before: ENTITLEMENT }, "allow"],
  ["collaborator reads (member)", { caller: collaborator, method: "get", path: ENT, before: ENTITLEMENT }, "allow"],
  ["agency owner reads", { caller: owner, method: "get", path: ENT, before: ENTITLEMENT }, "allow"],
  ["another sub-account's admin is denied", { caller: otherSaAdmin, method: "get", path: ENT, before: ENTITLEMENT }, "deny: not a member"],
  ["signed-out is denied", { caller: null, method: "get", path: ENT, before: ENTITLEMENT }, "deny"],
  ["admin cannot create one", { caller: saAdmin, method: "create", path: ENT, after: ENTITLEMENT }, "deny"],
  ["owner cannot create one", { caller: owner, method: "create", path: ENT, after: ENTITLEMENT }, "deny"],
  ["signed-out cannot create one", { caller: null, method: "create", path: ENT, after: ENTITLEMENT }, "deny"],
  ["admin cannot revoke one", { caller: saAdmin, method: "update", path: ENT, before: ENTITLEMENT, after: REVOKED }, "deny"],
  ["owner cannot revive a revoked one", { caller: owner, method: "update", path: ENT, before: REVOKED, after: ENTITLEMENT }, "deny"],
  ["collaborator cannot mark a failed delivery done", { caller: collaborator, method: "update", path: ENT, before: { ...ENTITLEMENT, fulfilment: { state: "failed", error: "x", at: 1 } }, after: ENTITLEMENT }, "deny"],
  ["admin cannot delete one", { caller: saAdmin, method: "delete", path: ENT, before: ENTITLEMENT }, "deny"],
  ["owner cannot delete one", { caller: owner, method: "delete", path: ENT, before: ENTITLEMENT }, "deny"],
];

describe.skipIf(!haveCreds)("entitlements — firestore rules", () => {
  let results: { allowed: boolean; errors: string[] }[] = [];

  beforeAll(async () => {
    results = await evaluate(CASES.map(([, c]) => c));
  }, 30_000);

  it.each(CASES.map(([name, , outcome], i) => [name, outcome, i] as const))("%s", (_name, outcome, i) => {
    const { allowed, errors } = results[i];
    if (outcome === "deny: not a member") {
      expect(errors.length).toBeGreaterThan(0);
      for (const e of errors) expect(e).toMatch(/Null value error/);
    } else {
      expect(errors).toEqual([]);
    }
    expect(allowed).toBe(outcome === "allow");
  });
});
