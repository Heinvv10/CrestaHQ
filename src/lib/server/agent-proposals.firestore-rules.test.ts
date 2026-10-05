import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken } from "../../test/rules-token";

/**
 * The repo's OWN firestore.rules for the Agent API approval queue, evaluated
 * through the Firebase Rules `projects:test` API — same harness and
 * credential rule as `src/lib/prospecting/prospecting.firestore-rules.test.ts`
 * (skips locally without FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * What must hold: members of the proposal's sub-account (and the agency
 * owner) read a row and its history; another sub-account's member is refused;
 * a row targeting a contact is territory-scoped like that contact (a scoped
 * collaborator cannot read another territory's row or its history); no client
 * writes anything — the dispatch, decide route and sweeps own it.
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
  /** Sub-account membership docs the rules may get(). null = no such doc. */
  memberships?: Record<string, { status: string; role: string; assignedTerritoryIds?: string[] } | null>;
}

interface Case {
  caller: Caller | null;
  method: Method;
  path: string;
  /** The stored doc (absent for create). */
  before?: Data;
  /** The doc as it would be after a create/update. */
  after?: Data;
  /** Other docs the rules may get(), by path under documents/. */
  gets?: Record<string, Data>;
}

async function evaluate(cases: Case[]): Promise<{ allowed: boolean; errors: string[] }[]> {
  const access_token = await rulesAccessToken(creds);
  const testCases = cases.map(({ caller, method, path, before, after, gets }) => ({
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
    functionMocks: [
      ...Object.entries(caller?.memberships ?? {}).map(([saId, data]) => ({
        function: "get",
        args: [{ exactValue: `${DOCS}subAccounts/${saId}/subAccountMembers/${caller!.uid}` }],
        result: { value: data === null ? null : { data } },
      })),
      ...Object.entries(gets ?? {}).map(([docPath, data]) => ({
        function: "get",
        args: [{ exactValue: `${DOCS}${docPath}` }],
        result: { value: { data } },
      })),
    ],
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

const ROW = {
  agencyId: "agency_a",
  subAccountId: "sa_1",
  createdByUid: "apikey:abcd1234",
  keyId: "key1",
  capability: "send_message",
  approval: "outbound",
  status: "pending",
  // Tenant-wide target: member-readable. Scoped rows below carry a territory.
  targetScoped: false,
};
const northRep: Caller = {
  uid: "rep_n",
  agencyId: "agency_a",
  agencyRole: "none",
  memberships: { sa_1: { status: "active", role: "collaborator", assignedTerritoryIds: ["north"] } },
};
const SOUTH_ROW = { ...ROW, contactId: "c_s", territoryId: "south", targetScoped: true };
const NORTH_ROW = { ...ROW, contactId: "c_n", territoryId: "north", targetScoped: true };
const SOUTH_DEAL_ROW = { ...ROW, contactId: null, territoryId: "south", targetScoped: true };
const SCOPING_ON = { "subAccounts/sa_1": { agencyId: "agency_a", territoryScopingEnabled: true } };
const SCOPING_OFF = { "subAccounts/sa_1": { agencyId: "agency_a", territoryScopingEnabled: false } };
const PRO = "agentProposals/p_1";
const HIS = "agentProposals/p_1/history/h1";
const PARENT = { [PRO]: ROW };

type Outcome = "allow" | "deny" | "deny: not a member";

const CASES: [string, Case, Outcome][] = [
  ["sub-account admin reads a proposal", { caller: saAdmin, method: "get", path: PRO, before: ROW }, "allow"],
  ["collaborator lists proposals (member)", { caller: collaborator, method: "list", path: PRO, before: ROW }, "allow"],
  ["agency owner reads a proposal", { caller: owner, method: "get", path: PRO, before: ROW }, "allow"],
  ["sa2's admin cannot read sa1's proposal", { caller: otherSaAdmin, method: "get", path: PRO, before: ROW }, "deny: not a member"],
  ["signed-out cannot read a proposal", { caller: null, method: "get", path: PRO, before: ROW }, "deny"],
  ["admin cannot create a proposal", { caller: saAdmin, method: "create", path: PRO, after: ROW }, "deny"],
  ["admin cannot approve a proposal client-side", { caller: saAdmin, method: "update", path: PRO, before: ROW, after: { ...ROW, status: "executing" } }, "deny"],
  ["owner cannot delete a proposal", { caller: owner, method: "delete", path: PRO, before: ROW }, "deny"],
  ["sub-account admin reads a history entry", { caller: saAdmin, method: "get", path: HIS, before: ROW, gets: PARENT }, "allow"],
  ["sa2's admin cannot read sa1's history", { caller: otherSaAdmin, method: "get", path: HIS, before: ROW, gets: PARENT }, "deny: not a member"],
  ["admin cannot write a history entry", { caller: saAdmin, method: "create", path: HIS, after: ROW, gets: PARENT }, "deny"],

  // ---- territory scoping (the row carries its contact's territoryId) ----
  ["scoped collaborator reads their territory's proposal", { caller: northRep, method: "get", path: PRO, before: NORTH_ROW, gets: SCOPING_ON }, "allow"],
  ["scoped collaborator cannot read another territory's proposal", { caller: northRep, method: "get", path: PRO, before: SOUTH_ROW, gets: SCOPING_ON }, "deny"],
  ["scoped collaborator cannot read another territory's history", { caller: northRep, method: "get", path: HIS, before: SOUTH_ROW, gets: { ...SCOPING_ON, [PRO]: SOUTH_ROW } }, "deny"],
  ["scoped collaborator cannot read a proposal whose contact has no territory", { caller: northRep, method: "get", path: PRO, before: { ...ROW, contactId: "c_x", territoryId: null, targetScoped: true }, gets: SCOPING_ON }, "deny"],
  ["scoped collaborator cannot read another territory's deal-target proposal (no contactId)", { caller: northRep, method: "get", path: PRO, before: SOUTH_DEAL_ROW, gets: SCOPING_ON }, "deny"],
  ["a row without targetScoped is treated as scoped (fail closed)", { caller: northRep, method: "get", path: PRO, before: { agencyId: "agency_a", subAccountId: "sa_1", status: "pending" }, gets: SCOPING_ON }, "deny"],
  ["scoped collaborator reads a tenant-wide proposal", { caller: northRep, method: "get", path: PRO, before: ROW, gets: SCOPING_ON }, "allow"],
  ["collaborator reads another territory's proposal when scoping is off", { caller: northRep, method: "get", path: PRO, before: SOUTH_ROW, gets: SCOPING_OFF }, "allow"],
  ["sub-account admin reads another territory's proposal", { caller: saAdmin, method: "get", path: PRO, before: SOUTH_ROW, gets: SCOPING_ON }, "allow"],
  ["scoped collaborator cannot write their territory's proposal", { caller: northRep, method: "update", path: PRO, before: NORTH_ROW, after: { ...NORTH_ROW, status: "executing" }, gets: SCOPING_ON }, "deny"],
];

describe.skipIf(!haveCreds)("agentProposals — firestore rules", () => {
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
