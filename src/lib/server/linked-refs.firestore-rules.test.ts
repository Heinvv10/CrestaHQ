import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken, rulesFetch } from "../../test/rules-api";

/**
 * The repo's OWN firestore.rules for the linked-record ids on client-written
 * tasks, quotes and events (`linkInTenant`), evaluated through the Firebase
 * Rules `projects:test` API — same harness and credential rule as
 * `src/lib/paystack/payments.firestore-rules.test.ts` (skips locally without
 * FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * What must hold: a contactId / dealId / eventId naming a record in ANOTHER
 * sub-account is refused on create and when changed on update; a same-
 * sub-account id, null, and an edit that leaves the link unchanged are
 * allowed. Each allow/deny pair differs only in the id under test.
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
  method: "create" | "update";
  path: string;
  before?: Data;
  after: Data;
}

const UID = "admin_1";
const getMock = (path: string, data: Data | null) => ({
  function: "get",
  args: [{ exactValue: `${DOCS}${path}` }],
  result: { value: data === null ? null : { data } },
});
const MOCKS = [
  getMock(`subAccounts/sa_1/subAccountMembers/${UID}`, { status: "active", role: "admin" }),
  getMock("subAccounts/sa_1", { territoryScopingEnabled: false }),
  // Linked records: `*_own` in sa_1, `*_foreign` in sa_2.
  ...["contacts", "deals", "events"].flatMap((c) => [
    getMock(`${c}/${c}_own`, { subAccountId: "sa_1", agencyId: "agency_a" }),
    getMock(`${c}/${c}_own2`, { subAccountId: "sa_1", agencyId: "agency_a" }),
    getMock(`${c}/${c}_foreign`, { subAccountId: "sa_2", agencyId: "agency_a" }),
  ]),
];

async function evaluate(cases: Case[]): Promise<{ allowed: boolean; errors: string[] }[]> {
  const access_token = await rulesAccessToken(creds);
  const testCases = cases.map(({ method, path, before, after }) => ({
    expectation: "ALLOW",
    request: {
      path: `${DOCS}${path}`,
      method,
      auth: { uid: UID, token: { status: "active", agencyId: "agency_a", agencyRole: "none" } },
      resource: { data: after },
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

const TENANT = { agencyId: "agency_a", subAccountId: "sa_1", createdByUid: UID, territoryId: null };
const TASK = { ...TENANT, title: "Call", contactId: null, dealId: null, eventId: null };
const QUOTE = { ...TENANT, kind: "quote", status: "draft", contactId: "contacts_own", dealId: null };
const EVENT = { ...TENANT, title: "Visit", contactId: null };

const CASES: [string, Case, "allow" | "deny"][] = [
  // ---- tasks ----
  ["tasks: create with no links", { method: "create", path: "tasks/t1", after: TASK }, "allow"],
  ["tasks: create linked to own contact/deal/event", { method: "create", path: "tasks/t1", after: { ...TASK, contactId: "contacts_own", dealId: "deals_own", eventId: "events_own" } }, "allow"],
  ["tasks: create linked to a foreign contact", { method: "create", path: "tasks/t1", after: { ...TASK, contactId: "contacts_foreign" } }, "deny"],
  ["tasks: create linked to a foreign deal", { method: "create", path: "tasks/t1", after: { ...TASK, dealId: "deals_foreign" } }, "deny"],
  ["tasks: create linked to a foreign event", { method: "create", path: "tasks/t1", after: { ...TASK, eventId: "events_foreign" } }, "deny"],
  ["tasks: re-link to own contact", { method: "update", path: "tasks/t1", before: { ...TASK, contactId: "contacts_own" }, after: { ...TASK, contactId: "contacts_own2" } }, "allow"],
  ["tasks: re-link to a foreign contact", { method: "update", path: "tasks/t1", before: { ...TASK, contactId: "contacts_own" }, after: { ...TASK, contactId: "contacts_foreign" } }, "deny"],
  ["tasks: re-link to a foreign deal", { method: "update", path: "tasks/t1", before: TASK, after: { ...TASK, dealId: "deals_foreign" } }, "deny"],
  ["tasks: re-link to a foreign event", { method: "update", path: "tasks/t1", before: TASK, after: { ...TASK, eventId: "events_foreign" } }, "deny"],
  ["tasks: unlink (null)", { method: "update", path: "tasks/t1", before: { ...TASK, contactId: "contacts_own" }, after: TASK }, "allow"],
  // Legacy doc already holding a foreign id: an unrelated edit still goes through.
  ["tasks: unrelated edit, link unchanged", { method: "update", path: "tasks/t1", before: { ...TASK, contactId: "contacts_foreign" }, after: { ...TASK, contactId: "contacts_foreign", title: "Renamed" } }, "allow"],

  // ---- quotes ----
  ["quotes: create for own contact", { method: "create", path: "quotes/q1", after: QUOTE }, "allow"],
  ["quotes: create for a foreign contact", { method: "create", path: "quotes/q1", after: { ...QUOTE, contactId: "contacts_foreign" } }, "deny"],
  ["quotes: create linked to a foreign deal", { method: "create", path: "quotes/q1", after: { ...QUOTE, dealId: "deals_foreign" } }, "deny"],
  ["quotes: re-point at a foreign contact", { method: "update", path: "quotes/q1", before: QUOTE, after: { ...QUOTE, contactId: "contacts_foreign" } }, "deny"],
  ["quotes: re-point at own contact", { method: "update", path: "quotes/q1", before: QUOTE, after: { ...QUOTE, contactId: "contacts_own2" } }, "allow"],
  ["quotes: unrelated edit", { method: "update", path: "quotes/q1", before: QUOTE, after: { ...QUOTE, status: "sent" } }, "allow"],

  // ---- events ----
  ["events: create standalone", { method: "create", path: "events/e1", after: EVENT }, "allow"],
  ["events: create for own contact", { method: "create", path: "events/e1", after: { ...EVENT, contactId: "contacts_own" } }, "allow"],
  ["events: create for a foreign contact", { method: "create", path: "events/e1", after: { ...EVENT, contactId: "contacts_foreign" } }, "deny"],
  ["events: re-link to a foreign contact", { method: "update", path: "events/e1", before: EVENT, after: { ...EVENT, contactId: "contacts_foreign" } }, "deny"],
  ["events: re-link to own contact", { method: "update", path: "events/e1", before: EVENT, after: { ...EVENT, contactId: "contacts_own" } }, "allow"],
  ["events: unrelated edit", { method: "update", path: "events/e1", before: EVENT, after: { ...EVENT, title: "Moved" } }, "allow"],
];

describe.skipIf(!haveCreds)("linked-record ids — firestore rules", () => {
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
