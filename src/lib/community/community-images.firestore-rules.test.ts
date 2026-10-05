import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken, rulesFetch } from "../../test/rules-api";

/**
 * The repo's OWN storage.rules for community cover/logo/course images,
 * through the Firebase Rules `projects:test` API — same harness and credential
 * rule as `src/lib/audit/audit-events.firestore-rules.test.ts` (skips locally
 * without FIREBASE_ADMIN_*, FAILS in CI without them). Nothing is deployed.
 *
 * What must hold: reads stay public (the /c/* About page), but only the
 * sub-account's admins or its agency owner may upload or delete — the same
 * callers the staff community routes admit (requireSubAccountAdmin). Being
 * signed in to Firebase is not enough: client sign-up is open.
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
const RULES = readFileSync(new URL("../../../storage.rules", import.meta.url), "utf8");
const PATH = "/b/bucket/o/community/sa_1/g1/cover-1.png";

type Method = "get" | "create" | "update" | "delete";

interface Caller {
  uid: string;
  token: Record<string, string>;
  /** sa_1 membership row; null = no such doc (get() returns null). */
  member?: { status: string; role: string } | null;
}

interface Case {
  caller: Caller | null;
  method: Method;
  file?: { size: number; contentType: string };
}

const IMAGE = { size: 1000, contentType: "image/png" };
const active = (agencyRole: string, agencyId = "agency_a") => ({ status: "active", agencyId, agencyRole });

const stranger: Caller = { uid: "stranger", token: {} };
const activeStranger: Caller = { uid: "stranger_2", token: active("none", "agency_x"), member: null };
const owner: Caller = { uid: "owner_a", token: active("owner"), member: null };
const otherOwner: Caller = { uid: "owner_b", token: active("owner", "agency_b"), member: null };
const admin: Caller = { uid: "admin_1", token: active("none"), member: { status: "active", role: "admin" } };
const collaborator: Caller = {
  uid: "collab_1",
  token: active("none"),
  member: { status: "active", role: "collaborator" },
};

async function evaluate(cases: Case[]): Promise<{ allowed: boolean; errors: string[] }[]> {
  const access_token = await rulesAccessToken(creds);
  const testCases = cases.map(({ caller, method, file }) => ({
    expectation: "ALLOW",
    request: {
      path: PATH,
      method,
      auth: caller ? { uid: caller.uid, token: caller.token } : null,
      ...(method === "create" || method === "update" ? { resource: file ?? IMAGE } : {}),
    },
    functionMocks: [
      {
        function: "firestore.get",
        args: [{ exactValue: `${DOCS}subAccounts/sa_1` }],
        result: { value: { data: { agencyId: "agency_a" } } },
      },
      ...(caller && caller.member !== undefined
        ? [
            {
              function: "firestore.get",
              args: [{ exactValue: `${DOCS}subAccounts/sa_1/subAccountMembers/${caller.uid}` }],
              result: { value: caller.member === null ? null : { data: caller.member } },
            },
          ]
        : []),
    ],
  }));
  const res = await rulesFetch(`https://firebaserules.googleapis.com/v1/projects/${creds.projectId}:test`, {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      source: { files: [{ name: "storage.rules", content: RULES }] },
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

type Outcome = "allow" | "deny" | "deny: not a member" | "deny: no claims";

const CASES: [string, Case, Outcome][] = [
  ["anyone reads (public About page)", { caller: null, method: "get" }, "allow"],
  ["sub-account admin uploads an image", { caller: admin, method: "create" }, "allow"],
  ["agency owner uploads an image", { caller: owner, method: "create" }, "allow"],
  ["sub-account admin deletes an image", { caller: admin, method: "delete" }, "allow"],
  ["agency owner deletes an image", { caller: owner, method: "delete" }, "allow"],
  ["signed-in stranger cannot upload", { caller: stranger, method: "create" }, "deny: no claims"],
  ["signed-in stranger cannot overwrite", { caller: stranger, method: "update" }, "deny: no claims"],
  ["signed-in stranger cannot delete", { caller: stranger, method: "delete" }, "deny: no claims"],
  ["active non-member cannot upload", { caller: activeStranger, method: "create" }, "deny: not a member"],
  ["active non-member cannot delete", { caller: activeStranger, method: "delete" }, "deny: not a member"],
  ["another agency's owner cannot upload", { caller: otherOwner, method: "create" }, "deny: not a member"],
  ["collaborator cannot upload", { caller: collaborator, method: "create" }, "deny"],
  ["collaborator cannot delete", { caller: collaborator, method: "delete" }, "deny"],
  ["signed-out cannot upload", { caller: null, method: "create" }, "deny"],
  [
    "admin cannot upload a non-image",
    { caller: admin, method: "create", file: { size: 1000, contentType: "text/html" } },
    "deny",
  ],
  [
    "admin cannot upload over 5 MB",
    { caller: admin, method: "create", file: { size: 6 * 1024 * 1024, contentType: "image/png" } },
    "deny",
  ],
];

describe.skipIf(!haveCreds)("community images — storage rules", () => {
  let results: { allowed: boolean; errors: string[] }[] = [];

  beforeAll(async () => {
    results = await evaluate(CASES.map(([, c]) => c));
  }, 30_000);

  it.each(CASES.map(([name, , outcome], i) => [name, outcome, i] as const))("%s", (_name, outcome, i) => {
    const { allowed, errors } = results[i];
    if (outcome === "deny: not a member") {
      // get() of a missing membership doc is null; `.data` on it errors —
      // the path a non-member takes in production.
      expect(errors.length).toBeGreaterThan(0);
      for (const e of errors) expect(e).toMatch(/Null value error/);
    } else if (outcome === "deny: no claims") {
      // A fresh client sign-up carries no custom claims at all; reading
      // token.status errors, which denies — the rule never admits them.
      expect(errors.length).toBeGreaterThan(0);
      for (const e of errors) expect(e).toMatch(/Property status is undefined/);
    } else {
      expect(errors).toEqual([]);
    }
    expect(allowed).toBe(outcome === "allow");
  });
});
