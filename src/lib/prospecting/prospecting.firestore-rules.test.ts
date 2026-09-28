import { readFileSync } from "node:fs";
import { cert } from "firebase-admin/app";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The repo's OWN firestore.rules for the Prospecting collections, evaluated
 * through the Firebase Rules `projects:test` API — same harness and the same
 * credential rule as `src/lib/audit/audit-events.firestore-rules.test.ts`
 * (skips locally without FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * What must hold:
 *   - `prospectLists`, `prospectReports`: members (and the agency owner)
 *     read; NO client writes — the lists route and the report runner own them.
 *   - `prospectReportShares`: no client reads or writes at all, not even the
 *     agency owner — the public report route resolves a share server-side.
 *   - A member of another sub-account is refused everywhere.
 *   - `contacts.prospecting` is server-owned: no client create may carry it
 *     and no client update may change it (other edits still go through).
 *
 * Every case asserts the evaluation raised no error (or, for a non-member,
 * exactly the Null value error of a missing membership doc), so a "deny"
 * means the rule said no — not that the set-up broke it.
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
  memberships?: Record<string, { status: string; role: string } | null>;
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
  const { access_token } = await cert(creds as Required<typeof creds>).getAccessToken();
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
const otherOwner: Caller = { uid: "owner_b", agencyId: "agency_b", agencyRole: "owner", memberships: { sa_1: null } };
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

const TENANT = { agencyId: "agency_a", subAccountId: "sa_1", createdByUid: "admin_1" };
const LIST = {
  ...TENANT,
  name: "Plumbers Gqeberha",
  query: { businessType: "plumber", placeName: "Gqeberha", lat: -33.96, lng: 25.6, radiusKm: 10 },
  count: 20,
};
const REPORT = { ...TENANT, contactId: "c1", status: "queued", sections: [], headline: null, shareId: null, generatedAt: null };
const SHARE = { ...TENANT, reportId: "r1", revokedAt: null };

type Outcome = "allow" | "deny" | "deny: not a member";

// A collaborator's contact access reads the sub-account's territory toggle.
const SA_DOC = { "subAccounts/sa_1": { agencyId: "agency_a", territoryScopingEnabled: false } };
const CONTACT = { ...TENANT, name: "Aqua Plumbing", mode: "live", territoryId: "global", tags: [] };
const PROSPECT = { ...CONTACT, prospecting: { listId: "list1", approachedAt: null, lastReportId: null } };
const CON = "contacts/c1";

const LST = "prospectLists/list1";
const RPT = "prospectReports/r1";
const SHR = "prospectReportShares/share1";
const FTC = "subAccounts/sa_1/prospectingFirstTouch/2026-09-27";

const CASES: [string, Case, Outcome][] = [
  // ---- prospectLists: member-read, server-only write ----
  ["lists: sub-account admin reads", { caller: saAdmin, method: "get", path: LST, before: LIST }, "allow"],
  ["lists: collaborator lists (member)", { caller: collaborator, method: "list", path: LST, before: LIST }, "allow"],
  ["lists: agency owner reads", { caller: owner, method: "get", path: LST, before: LIST }, "allow"],
  ["lists: another sub-account's admin is denied", { caller: otherSaAdmin, method: "get", path: LST, before: LIST }, "deny: not a member"],
  ["lists: another agency's owner is denied", { caller: otherOwner, method: "get", path: LST, before: LIST }, "deny: not a member"],
  ["lists: signed-out is denied", { caller: null, method: "get", path: LST, before: LIST }, "deny"],
  ["lists: admin cannot create one", { caller: saAdmin, method: "create", path: LST, after: LIST }, "deny"],
  ["lists: owner cannot create one", { caller: owner, method: "create", path: LST, after: LIST }, "deny"],
  ["lists: admin cannot rename one", { caller: saAdmin, method: "update", path: LST, before: LIST, after: { ...LIST, name: "x" } }, "deny"],
  ["lists: admin cannot delete one", { caller: saAdmin, method: "delete", path: LST, before: LIST }, "deny"],

  // ---- prospectReports: member-read, server-only write ----
  ["reports: sub-account admin reads", { caller: saAdmin, method: "get", path: RPT, before: REPORT }, "allow"],
  ["reports: collaborator lists (member)", { caller: collaborator, method: "list", path: RPT, before: REPORT }, "allow"],
  ["reports: agency owner reads", { caller: owner, method: "get", path: RPT, before: REPORT }, "allow"],
  ["reports: another sub-account's admin is denied", { caller: otherSaAdmin, method: "get", path: RPT, before: REPORT }, "deny: not a member"],
  ["reports: signed-out is denied", { caller: null, method: "get", path: RPT, before: REPORT }, "deny"],
  ["reports: admin cannot create one", { caller: saAdmin, method: "create", path: RPT, after: REPORT }, "deny"],
  ["reports: collaborator cannot create one", { caller: collaborator, method: "create", path: RPT, after: REPORT }, "deny"],
  ["reports: admin cannot mark one ready", { caller: saAdmin, method: "update", path: RPT, before: REPORT, after: { ...REPORT, status: "ready", headline: "x" } }, "deny"],
  ["reports: owner cannot mark one ready", { caller: owner, method: "update", path: RPT, before: REPORT, after: { ...REPORT, status: "ready" } }, "deny"],
  ["reports: admin cannot delete one", { caller: saAdmin, method: "delete", path: RPT, before: REPORT }, "deny"],

  // ---- prospectReportShares: no client at all ----
  ["shares: agency owner cannot read one", { caller: owner, method: "get", path: SHR, before: SHARE }, "deny"],
  ["shares: sub-account admin cannot read one", { caller: saAdmin, method: "get", path: SHR, before: SHARE }, "deny"],
  ["shares: sub-account admin cannot list them", { caller: saAdmin, method: "list", path: SHR, before: SHARE }, "deny"],
  ["shares: another sub-account's admin cannot read one", { caller: otherSaAdmin, method: "get", path: SHR, before: SHARE }, "deny"],
  ["shares: signed-out cannot read one", { caller: null, method: "get", path: SHR, before: SHARE }, "deny"],
  ["shares: admin cannot create one", { caller: saAdmin, method: "create", path: SHR, after: SHARE }, "deny"],
  ["shares: owner cannot revoke one", { caller: owner, method: "update", path: SHR, before: SHARE, after: { ...SHARE, revokedAt: 1 } }, "deny"],

  // ---- prospectingFirstTouch day counters (approach guard): no client at all ----
  ["first-touch counter: sub-account admin cannot read it", { caller: saAdmin, method: "get", path: FTC, before: { count: 3 } }, "deny"],
  ["first-touch counter: agency owner cannot reset it", { caller: owner, method: "update", path: FTC, before: { count: 20 }, after: { count: 0 } }, "deny"],

  // ---- contacts.prospecting: server-owned ----
  ["contacts: collaborator edits a prospect's name (map unchanged)", { caller: collaborator, method: "update", path: CON, before: PROSPECT, after: { ...PROSPECT, name: "Aqua Plumbing (Pty)" }, gets: SA_DOC }, "allow"],
  ["contacts: collaborator cannot stamp prospecting.approachedAt", { caller: collaborator, method: "update", path: CON, before: PROSPECT, after: { ...PROSPECT, prospecting: { ...PROSPECT.prospecting, approachedAt: 1 } }, gets: SA_DOC }, "deny"],
  ["contacts: admin cannot stamp prospecting.approachedWorkflowId", { caller: saAdmin, method: "update", path: CON, before: PROSPECT, after: { ...PROSPECT, prospecting: { ...PROSPECT.prospecting, approachedWorkflowId: "wf1" } }, gets: SA_DOC }, "deny"],
  ["contacts: admin cannot add a prospecting map to a contact", { caller: saAdmin, method: "update", path: CON, before: CONTACT, after: PROSPECT }, "deny"],
  ["contacts: collaborator creates a contact without the map", { caller: collaborator, method: "create", path: CON, after: CONTACT }, "allow"],
  ["contacts: collaborator cannot create a contact carrying the map", { caller: collaborator, method: "create", path: CON, after: PROSPECT }, "deny"],
];

describe.skipIf(!haveCreds)("prospecting collections — firestore rules", () => {
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
