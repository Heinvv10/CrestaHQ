import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken, rulesFetch } from "../../test/rules-api";

/**
 * The repo's OWN firestore.rules for imported Google events (`source:
 * "google"`, written only by lib/google-calendar/import.ts), evaluated
 * through the Firebase Rules `projects:test` API — same harness and
 * credential rule as src/lib/server/linked-refs.firestore-rules.test.ts
 * (skips locally without FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * What must hold: no client — not even the event's owner or an admin — can
 * update or delete an imported event, or create one; a manual event stays
 * editable and deletable; every member can read an imported event. Each
 * allow/deny pair differs only in `source`.
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

type Data = Record<string, unknown>;
interface Case {
  method: "get" | "create" | "update" | "delete";
  uid: string;
  before?: Data;
  after?: Data;
}

const OWNER = "member_owner";
const COLLEAGUE = "member_colleague";
const ADMIN = "admin_1";
const getMock = (path: string, data: Data | null) => ({
  function: "get",
  args: [{ exactValue: `${DOCS}${path}` }],
  result: { value: data === null ? null : { data } },
});
const MOCKS = [
  getMock(`subAccounts/sa_1/subAccountMembers/${OWNER}`, { status: "active", role: "collaborator" }),
  getMock(`subAccounts/sa_1/subAccountMembers/${COLLEAGUE}`, { status: "active", role: "collaborator" }),
  getMock(`subAccounts/sa_1/subAccountMembers/${ADMIN}`, { status: "active", role: "admin" }),
  getMock("subAccounts/sa_1", { territoryScopingEnabled: false }),
];

async function evaluate(cases: Case[]): Promise<{ allowed: boolean; errors: string[] }[]> {
  const access_token = await rulesAccessToken(creds);
  const testCases = cases.map(({ method, uid, before, after }) => ({
    expectation: "ALLOW",
    request: {
      path: `${DOCS}events/e1`,
      method,
      auth: { uid, token: { status: "active", agencyId: "agency_a", agencyRole: "none" } },
      ...(after ? { resource: { data: after } } : {}),
    },
    resource: before ? { data: before } : null,
    functionMocks: MOCKS,
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

const TENANT = { agencyId: "agency_a", subAccountId: "sa_1", territoryId: "global" };
/** As the import writes it (import-map.ts importedEventDoc). */
const IMPORTED = {
  ...TENANT,
  title: "Busy",
  location: "",
  notes: "",
  contactId: null,
  meetingUrl: null,
  status: "scheduled",
  source: "google",
  importOwnerUid: OWNER,
  importMode: "busy",
  allDay: false,
  isLong: false,
  createdByUid: OWNER,
};
/** The same doc, typed in by hand. */
const MANUAL = { ...IMPORTED, source: "manual", createdByUid: OWNER };
const { source: _s, ...LEGACY } = MANUAL;

const CASES: [string, Case, "allow" | "deny"][] = [
  ["read: a colleague reads an imported event", { method: "get", uid: COLLEAGUE, before: IMPORTED }, "allow"],
  ["read: the owner reads their imported event", { method: "get", uid: OWNER, before: IMPORTED }, "allow"],

  ["update: the owner retitles their imported event", { method: "update", uid: OWNER, before: IMPORTED, after: { ...IMPORTED, title: "Dentist" } }, "deny"],
  ["update: a colleague retitles an imported event", { method: "update", uid: COLLEAGUE, before: IMPORTED, after: { ...IMPORTED, title: "Dentist" } }, "deny"],
  ["update: an admin moves an imported event", { method: "update", uid: ADMIN, before: IMPORTED, after: { ...IMPORTED, notes: "moved" } }, "deny"],
  ["update: cancelling an imported event", { method: "update", uid: OWNER, before: IMPORTED, after: { ...IMPORTED, status: "cancelled" } }, "deny"],
  ["update: the same edit on a manual event", { method: "update", uid: OWNER, before: MANUAL, after: { ...MANUAL, title: "Dentist" } }, "allow"],
  ["update: the same edit on a legacy event (no source)", { method: "update", uid: OWNER, before: LEGACY, after: { ...LEGACY, title: "Dentist" } }, "allow"],
  ["update: an admin edits a manual event", { method: "update", uid: ADMIN, before: MANUAL, after: { ...MANUAL, notes: "moved" } }, "allow"],

  ["delete: the owner deletes their imported event", { method: "delete", uid: OWNER, before: IMPORTED }, "deny"],
  ["delete: an admin deletes an imported event", { method: "delete", uid: ADMIN, before: IMPORTED }, "deny"],
  ["delete: the owner deletes a manual event", { method: "delete", uid: OWNER, before: MANUAL }, "allow"],
  ["delete: an admin deletes a legacy event (no source)", { method: "delete", uid: ADMIN, before: LEGACY }, "allow"],

  ["create: a client writes an imported event", { method: "create", uid: OWNER, after: IMPORTED }, "deny"],
  ["create: the same doc without source", { method: "create", uid: OWNER, after: LEGACY }, "allow"],
];

describe.skipIf(!haveCreds)("imported Google events — firestore rules", () => {
  let results: { allowed: boolean; errors: string[] }[] = [];

  beforeAll(async () => {
    results = await evaluate(CASES.map(([, c]) => c));
  }, 30_000);

  it.each(CASES.map(([name, , outcome], i) => [name, outcome, i] as const))("%s", (_name, outcome, i) => {
    const { allowed, errors } = results[i];
    expect(errors).toEqual([]);
    expect(allowed).toBe(outcome === "allow");
  });
});
