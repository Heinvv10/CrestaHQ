import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken } from "../../test/rules-token";

/**
 * The repo's OWN firestore.rules for the Paystack money records, evaluated
 * through the Firebase Rules `projects:test` API — same harness and the same
 * credential rule as `src/lib/audit/audit-events.firestore-rules.test.ts`
 * (skips locally without FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * What must hold:
 *   - `paymentAttempts` and `paymentLinks`: members read, NO client writes.
 *     An attempt's mode and key fingerprint decide whether a payment may be
 *     recorded, and a link's `status: "paid"` is a statement about money.
 *   - `paymentMandates`: members read the display doc, NO client writes;
 *     its `private/authorization` (what can charge the card) no client may
 *     read or write — not even the agency owner.
 *   - `quotes.paidVia`: no member may create, add, change or remove it. The
 *     reconciler trusts it to tell its own payment from one made another way.
 *
 * Every allow/deny pair differs only in the field under test, so a deny
 * cannot be passing for an unrelated reason.
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
}

/** Answer for the territory-scoping lookup a collaborator's quote write makes. */
const SUB_DOC_MOCK = {
  function: "get",
  args: [{ exactValue: `${DOCS}subAccounts/sa_1` }],
  result: { value: { data: { territoryScopingEnabled: false } } },
};

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
    functionMocks: [
      ...Object.entries(caller?.memberships ?? {}).map(([saId, data]) => ({
        function: "get",
        args: [{ exactValue: `${DOCS}subAccounts/${saId}/subAccountMembers/${caller!.uid}` }],
        result: { value: data === null ? null : { data } },
      })),
      SUB_DOC_MOCK,
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

const TENANT = { agencyId: "agency_a", subAccountId: "sa_1", createdByUid: "admin_1" };
const ATTEMPT = {
  ...TENANT,
  paymentLinkId: "link1",
  amountCents: 115000,
  currency: "ZAR",
  mode: "live",
  keyFingerprint: "fp-live-key",
  state: "open",
  reason: null,
};
const SETTLED_ATTEMPT = { ...ATTEMPT, state: "settled" };
const LINK = { ...TENANT, invoiceId: "inv1", amountCents: 115000, currency: "ZAR", mode: "live", status: "open", active: true };
const PAID_LINK = { ...LINK, status: "paid" };
const QUOTE = { ...TENANT, kind: "invoice", status: "sent", quoteNumber: "INV-1", paidVia: null };
const AUTO_CHARGE = { reference: "ra-s1-c1", mandateId: "m1", state: "declined", reason: "Declined" };
const PAID_VIA = { rail: "paystack_link", linkId: "link1", reference: "pl-link1-0123456789abcdef" };

const MANDATE = {
  ...TENANT,
  contactId: "c1",
  recurringInvoiceId: "rec1",
  paymentLinkId: "link1",
  mode: "live",
  keyFingerprint: "fp-live-key",
  status: "active",
  attention: null,
};
const SECRET = { authorizationCode: "AUTH_x", customerCode: "CUS_x", email: "payer@example.com", signature: null };

type Outcome = "allow" | "deny" | "deny: not a member";

const ATT = "paymentAttempts/pl-link1-0123456789abcdef";
const LNK = "paymentLinks/link1";
const QTE = "quotes/inv1";
const MND = "paymentMandates/pl-link1-0123456789abcdef";
const MND_SECRET = `${MND}/private/authorization`;

const CASES: [string, Case, Outcome][] = [
  // ---- paymentAttempts: member-read, server-only write ----
  ["attempts: sub-account admin reads", { caller: saAdmin, method: "get", path: ATT, before: ATTEMPT }, "allow"],
  ["attempts: sub-account admin lists", { caller: saAdmin, method: "list", path: ATT, before: ATTEMPT }, "allow"],
  ["attempts: collaborator reads (member)", { caller: collaborator, method: "get", path: ATT, before: ATTEMPT }, "allow"],
  ["attempts: agency owner reads", { caller: owner, method: "get", path: ATT, before: ATTEMPT }, "allow"],
  ["attempts: another sub-account's admin is denied", { caller: otherSaAdmin, method: "get", path: ATT, before: ATTEMPT }, "deny: not a member"],
  ["attempts: signed-out is denied", { caller: null, method: "get", path: ATT, before: ATTEMPT }, "deny"],
  ["attempts: admin cannot create one", { caller: saAdmin, method: "create", path: ATT, after: ATTEMPT }, "deny"],
  ["attempts: owner cannot create one", { caller: owner, method: "create", path: ATT, after: ATTEMPT }, "deny"],
  ["attempts: admin cannot settle one", { caller: saAdmin, method: "update", path: ATT, before: ATTEMPT, after: SETTLED_ATTEMPT }, "deny"],
  ["attempts: owner cannot change its mode", { caller: owner, method: "update", path: ATT, before: ATTEMPT, after: { ...ATTEMPT, mode: "test" } }, "deny"],
  ["attempts: admin cannot delete one", { caller: saAdmin, method: "delete", path: ATT, before: ATTEMPT }, "deny"],

  // ---- paymentLinks: member-read, server-only write ----
  ["links: sub-account admin reads", { caller: saAdmin, method: "get", path: LNK, before: LINK }, "allow"],
  ["links: agency owner lists", { caller: owner, method: "list", path: LNK, before: LINK }, "allow"],
  ["links: another sub-account's admin is denied", { caller: otherSaAdmin, method: "get", path: LNK, before: LINK }, "deny: not a member"],
  ["links: signed-out is denied", { caller: null, method: "get", path: LNK, before: LINK }, "deny"],
  ["links: admin cannot create one", { caller: saAdmin, method: "create", path: LNK, after: LINK }, "deny"],
  ["links: admin cannot mark one paid", { caller: saAdmin, method: "update", path: LNK, before: LINK, after: PAID_LINK }, "deny"],
  ["links: owner cannot mark one paid", { caller: owner, method: "update", path: LNK, before: LINK, after: PAID_LINK }, "deny"],
  ["links: admin cannot delete one", { caller: saAdmin, method: "delete", path: LNK, before: LINK }, "deny"],

  // ---- paymentMandates: member-read display doc, server-only write ----
  ["mandates: sub-account admin reads", { caller: saAdmin, method: "get", path: MND, before: MANDATE }, "allow"],
  ["mandates: collaborator lists (member)", { caller: collaborator, method: "list", path: MND, before: MANDATE }, "allow"],
  ["mandates: agency owner reads", { caller: owner, method: "get", path: MND, before: MANDATE }, "allow"],
  ["mandates: another sub-account's admin is denied", { caller: otherSaAdmin, method: "get", path: MND, before: MANDATE }, "deny: not a member"],
  ["mandates: signed-out is denied", { caller: null, method: "get", path: MND, before: MANDATE }, "deny"],
  ["mandates: admin cannot create one", { caller: saAdmin, method: "create", path: MND, after: MANDATE }, "deny"],
  ["mandates: owner cannot revive a revoked one", { caller: owner, method: "update", path: MND, before: { ...MANDATE, status: "revoked" }, after: MANDATE }, "deny"],
  ["mandates: admin cannot revoke one directly", { caller: saAdmin, method: "update", path: MND, before: MANDATE, after: { ...MANDATE, status: "revoked" } }, "deny"],
  ["mandates: owner cannot change its key fingerprint", { caller: owner, method: "update", path: MND, before: MANDATE, after: { ...MANDATE, keyFingerprint: "fp-other" } }, "deny"],
  ["mandates: admin cannot delete one", { caller: saAdmin, method: "delete", path: MND, before: MANDATE }, "deny"],

  // ---- paymentMandates/{id}/private: the authorization — no client at all ----
  ["mandate secret: agency owner cannot read it", { caller: owner, method: "get", path: MND_SECRET, before: { ...TENANT, ...SECRET } }, "deny"],
  ["mandate secret: sub-account admin cannot read it", { caller: saAdmin, method: "get", path: MND_SECRET, before: { ...TENANT, ...SECRET } }, "deny"],
  ["mandate secret: sub-account admin cannot list it", { caller: saAdmin, method: "list", path: MND_SECRET, before: { ...TENANT, ...SECRET } }, "deny"],
  ["mandate secret: owner cannot write it", { caller: owner, method: "create", path: MND_SECRET, after: { ...TENANT, ...SECRET } }, "deny"],

  // ---- quotes.paidVia: no client may write it ----
  ["quotes: admin edits a quote, paidVia untouched (control)", { caller: saAdmin, method: "update", path: QTE, before: QUOTE, after: { ...QUOTE, status: "viewed" } }, "allow"],
  ["quotes: admin cannot set paidVia", { caller: saAdmin, method: "update", path: QTE, before: QUOTE, after: { ...QUOTE, paidVia: PAID_VIA } }, "deny"],
  ["quotes: admin cannot change paidVia", { caller: saAdmin, method: "update", path: QTE, before: { ...QUOTE, status: "paid", paidVia: PAID_VIA }, after: { ...QUOTE, status: "paid", paidVia: { ...PAID_VIA, linkId: "link2" } } }, "deny"],
  ["quotes: admin cannot clear paidVia", { caller: saAdmin, method: "update", path: QTE, before: { ...QUOTE, status: "paid", paidVia: PAID_VIA }, after: { ...QUOTE, status: "paid", paidVia: null } }, "deny"],
  ["quotes: owner cannot set paidVia", { caller: owner, method: "update", path: QTE, before: QUOTE, after: { ...QUOTE, paidVia: PAID_VIA } }, "deny"],
  ["quotes: collaborator edits a quote, paidVia untouched (control)", { caller: collaborator, method: "update", path: QTE, before: QUOTE, after: { ...QUOTE, status: "viewed" } }, "allow"],
  ["quotes: collaborator cannot set paidVia", { caller: collaborator, method: "update", path: QTE, before: QUOTE, after: { ...QUOTE, paidVia: PAID_VIA } }, "deny"],
  ["quotes: admin creates a quote without paidVia (control)", { caller: saAdmin, method: "create", path: QTE, after: (({ paidVia: _, ...q }) => q)(QUOTE) }, "allow"],
  ["quotes: admin cannot create a quote carrying paidVia", { caller: saAdmin, method: "create", path: QTE, after: { ...QUOTE, paidVia: PAID_VIA } }, "deny"],
  ["quotes: admin cannot create a quote carrying paidVia: null", { caller: saAdmin, method: "create", path: QTE, after: QUOTE }, "deny"],

  // ---- quotes.autoCharge: no client may write it ----
  ["quotes: admin cannot set autoCharge", { caller: saAdmin, method: "update", path: QTE, before: QUOTE, after: { ...QUOTE, autoCharge: AUTO_CHARGE } }, "deny"],
  ["quotes: admin cannot change autoCharge", { caller: saAdmin, method: "update", path: QTE, before: { ...QUOTE, autoCharge: AUTO_CHARGE }, after: { ...QUOTE, autoCharge: { ...AUTO_CHARGE, state: "paid" } } }, "deny"],
  ["quotes: admin cannot clear autoCharge", { caller: saAdmin, method: "update", path: QTE, before: { ...QUOTE, autoCharge: AUTO_CHARGE }, after: QUOTE }, "deny"],
  ["quotes: collaborator cannot set autoCharge", { caller: collaborator, method: "update", path: QTE, before: QUOTE, after: { ...QUOTE, autoCharge: AUTO_CHARGE } }, "deny"],
  ["quotes: admin edits a quote with autoCharge untouched (control)", { caller: saAdmin, method: "update", path: QTE, before: { ...QUOTE, autoCharge: AUTO_CHARGE }, after: { ...QUOTE, autoCharge: AUTO_CHARGE, status: "viewed" } }, "allow"],
  ["quotes: admin cannot create a quote carrying autoCharge", { caller: saAdmin, method: "create", path: QTE, after: { ...(({ paidVia: _, ...q }) => q)(QUOTE), autoCharge: AUTO_CHARGE } }, "deny"],
  ["quotes: admin cannot create a quote carrying autoCharge: null", { caller: saAdmin, method: "create", path: QTE, after: { ...(({ paidVia: _, ...q }) => q)(QUOTE), autoCharge: null } }, "deny"],
];

describe.skipIf(!haveCreds)("payment records — firestore rules", () => {
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
