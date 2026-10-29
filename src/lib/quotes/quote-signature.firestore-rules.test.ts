import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { rulesAccessToken, rulesFetch } from "../../test/rules-api";

/**
 * The repo's OWN firestore.rules for a quote's e-signature, evaluated through
 * the Firebase Rules `projects:test` API — same harness and credential rule
 * as `src/lib/paystack/payments.firestore-rules.test.ts` (skips locally
 * without FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * What must hold:
 *   - `signature` is written only by the public accept route (Admin SDK): no
 *     member may create a quote carrying one, add one, change it or clear it.
 *   - Once signed, a quote's content is frozen so its fingerprint stays true:
 *     only `updatedAt`, `status`, `paidAt`, `autoCreateDealOnAccept`,
 *     `dealId` and `paymentDueDays` may move. An edit that touches one of
 *     those AND anything else is refused (the `hasOnly` cases below).
 *   - No client deletes a signed quote, or the invoice it was converted to.
 *   - On a signed quote `paidVia` / `autoCharge` can't be proven locked on
 *     their own: neither is in the allow-list, so ANY change to them is an
 *     affected key `hasOnly` already refuses, and no case can separate the
 *     two. Their own locks are proven on unsigned quotes in
 *     src/lib/paystack/payments.firestore-rules.test.ts; the signed cases
 *     below only pin that the combination still refuses.
 *   - An unsigned quote stays editable exactly as before.
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

type Method = "get" | "create" | "update" | "delete";
type Data = Record<string, unknown>;

interface Caller {
  uid: string;
  agencyId: string;
  agencyRole: "owner" | "none";
  /** Sub-account membership docs the rules may get(). */
  memberships?: Record<string, { status: string; role: string }>;
}

interface Case {
  caller: Caller;
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
      auth: { uid: caller.uid, token: { status: "active", agencyId: caller.agencyId, agencyRole: caller.agencyRole } },
      ...(after ? { resource: { data: after } } : {}),
    },
    resource: before ? { data: before } : null,
    functionMocks: [
      ...Object.entries(caller.memberships ?? {}).map(([saId, data]) => ({
        function: "get",
        args: [{ exactValue: `${DOCS}subAccounts/${saId}/subAccountMembers/${caller.uid}` }],
        result: { value: { data } },
      })),
      SUB_DOC_MOCK,
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

const TENANT = { agencyId: "agency_a", subAccountId: "sa_1", createdByUid: "admin_1" };
const LINE = { id: "li1", description: "Fibre install", quantity: 1, unitPrice: 1500 };
// contactId and dealId are carried unchanged, which linkInTenant passes without a lookup.
const QUOTE: Data = {
  ...TENANT,
  kind: "quote",
  status: "viewed",
  quoteNumber: "Q-2026-0007",
  contactId: "c1",
  dealId: "d1",
  currency: "ZAR",
  lineItems: [LINE],
  globalDiscount: null,
  globalTaxPercent: 15,
  termsAndNotes: "50% deposit.",
  billedToOrganization: null,
  billingAddress: null,
  validUntil: null,
  paymentDueDays: null,
  autoCreateDealOnAccept: true,
  requireSignature: true,
  signature: null,
  paidAt: null,
  updatedAt: 1,
};
const SIG = {
  signerName: "Jane Doe",
  signedAsNumber: "Q-2026-0007",
  signerEmail: "jane@example.com",
  signedAt: 1,
  ipAddress: "203.0.113.9",
  userAgent: "ua",
  documentHash: "a".repeat(64),
  hashVersion: 1,
};
const SIGNED: Data = { ...QUOTE, status: "accepted", signature: SIG };
// A create has no stored doc for linkInTenant to compare against, so the
// created quote names no contact or deal (a named one costs a lookup mock).
const { signature: _omit, contactId: _c, dealId: _d, ...UNSTAMPED } = QUOTE;
const PAID_VIA = { rail: "paystack_link", linkId: "link1", reference: "pl-link1-0123456789abcdef" };
const AUTO_CHARGE = { reference: "ra-s1-c1", mandateId: "m1", state: "declined", reason: "Declined" };

const QTE = "quotes/q1";
const upd = (caller: Caller, before: Data, patch: Data): Case => ({ caller, method: "update", path: QTE, before, after: { ...before, ...patch } });

const CASES: [string, Case, "allow" | "deny"][] = [
  // ---- create: never carrying a signature ----
  ["create: admin creates a quote without signature (control)", { caller: saAdmin, method: "create", path: QTE, after: UNSTAMPED }, "allow"],
  ["create: admin cannot create one carrying a signature", { caller: saAdmin, method: "create", path: QTE, after: { ...UNSTAMPED, signature: SIG } }, "deny"],
  ["create: owner cannot create one carrying a signature", { caller: owner, method: "create", path: QTE, after: { ...UNSTAMPED, status: "accepted", signature: SIG } }, "deny"],
  ["create: admin cannot create one carrying signature: null", { caller: saAdmin, method: "create", path: QTE, after: { ...UNSTAMPED, signature: null } }, "deny"],

  // ---- an unsigned quote: editable as before, but never signed by a client ----
  ["unsigned: admin edits the lines (control)", upd(saAdmin, QUOTE, { lineItems: [{ ...LINE, unitPrice: 1400 }], updatedAt: 2 }), "allow"],
  ["unsigned: collaborator edits the terms (control)", upd(collaborator, QUOTE, { termsAndNotes: "Full payment.", updatedAt: 2 }), "allow"],
  ["unsigned: admin turns the signature requirement off (control)", upd(saAdmin, QUOTE, { requireSignature: false, updatedAt: 2 }), "allow"],
  ["unsigned: admin cannot add a signature", upd(saAdmin, QUOTE, { status: "accepted", signature: SIG }), "deny"],
  ["unsigned: owner cannot add a signature", upd(owner, QUOTE, { signature: SIG }), "deny"],
  ["unsigned: collaborator cannot add a signature", upd(collaborator, QUOTE, { signature: SIG }), "deny"],

  // ---- a signed quote: the signature itself never changes ----
  ["signed: admin cannot change the signer's name", upd(saAdmin, SIGNED, { signature: { ...SIG, signerName: "Someone Else" } }), "deny"],
  ["signed: admin cannot change the fingerprint", upd(saAdmin, SIGNED, { signature: { ...SIG, documentHash: "b".repeat(64) } }), "deny"],
  ["signed: owner cannot clear the signature", upd(owner, SIGNED, { signature: null }), "deny"],
  ["signed: admin cannot remove the signature", { caller: saAdmin, method: "update", path: QTE, before: SIGNED, after: (({ signature: _s, ...q }) => q)(SIGNED) }, "deny"],

  // ---- a signed quote: content frozen ----
  ["signed: admin cannot edit a line item", upd(saAdmin, SIGNED, { lineItems: [{ ...LINE, unitPrice: 1400 }] }), "deny"],
  ["signed: owner cannot add a line item", upd(owner, SIGNED, { lineItems: [LINE, { ...LINE, id: "li2" }] }), "deny"],
  ["signed: admin cannot change the currency", upd(saAdmin, SIGNED, { currency: "USD" }), "deny"],
  ["signed: admin cannot change the discount", upd(saAdmin, SIGNED, { globalDiscount: { type: "percent", value: 10 } }), "deny"],
  ["signed: admin cannot change the tax", upd(saAdmin, SIGNED, { globalTaxPercent: 0 }), "deny"],
  ["signed: collaborator cannot change the terms", upd(collaborator, SIGNED, { termsAndNotes: "Full payment." }), "deny"],
  ["signed: admin cannot change who it is billed to", upd(saAdmin, SIGNED, { billedToOrganization: "Someone Else Ltd" }), "deny"],
  ["signed: admin cannot change the billing address", upd(saAdmin, SIGNED, { billingAddress: "2 Main Rd" }), "deny"],
  ["signed: admin cannot change the validity", upd(saAdmin, SIGNED, { validUntil: 99 }), "deny"],
  ["signed: admin cannot change the number", upd(saAdmin, SIGNED, { quoteNumber: "Q-2026-0099" }), "deny"],
  ["signed: admin cannot change the kind", upd(saAdmin, SIGNED, { kind: "invoice" }), "deny"],
  ["signed: admin cannot turn the requirement off", upd(saAdmin, SIGNED, { requireSignature: false }), "deny"],
  // hasOnly, not hasAny: allowed keys riding along don't carry a forbidden one.
  ["signed: allowed keys plus a line edit is refused", upd(saAdmin, SIGNED, { status: "paid", paidAt: 5, updatedAt: 2, lineItems: [{ ...LINE, unitPrice: 1 }] }), "deny"],
  ["signed: allowed keys plus a terms edit is refused", upd(collaborator, SIGNED, { updatedAt: 2, termsAndNotes: "Changed." }), "deny"],

  // ---- a signed quote: the lifecycle keys still move ----
  ["signed: admin marks it paid (status, paidAt, updatedAt)", upd(saAdmin, SIGNED, { status: "paid", paidAt: 5, updatedAt: 2 }), "allow"],
  ["signed: collaborator changes the status", upd(collaborator, SIGNED, { status: "paid", updatedAt: 2 }), "allow"],
  ["signed: admin toggles auto-create deal", upd(saAdmin, SIGNED, { autoCreateDealOnAccept: false, updatedAt: 2 }), "allow"],
  ["signed: admin unlinks the deal", upd(saAdmin, SIGNED, { dealId: null, updatedAt: 2 }), "allow"],
  ["signed: owner sets the payment due days", upd(owner, SIGNED, { paymentDueDays: 14, updatedAt: 2 }), "allow"],
  ["signed: admin touches only updatedAt", upd(saAdmin, SIGNED, { updatedAt: 2 }), "allow"],

  // ---- money fields on a signed quote (refused by hasOnly too; see the header) ----
  ["signed: admin cannot set paidVia", upd(saAdmin, SIGNED, { status: "paid", paidVia: PAID_VIA }), "deny"],
  ["signed: admin cannot set autoCharge", upd(saAdmin, SIGNED, { autoCharge: AUTO_CHARGE }), "deny"],

  // ---- reads unchanged; a signed doc is never deleted by a client ----
  ["signed: collaborator reads it", { caller: collaborator, method: "get", path: QTE, before: SIGNED }, "allow"],
  ["unsigned: admin deletes a draft (control)", { caller: saAdmin, method: "delete", path: QTE, before: { ...QUOTE, status: "draft" } }, "allow"],
  ["signed: admin cannot delete it", { caller: saAdmin, method: "delete", path: QTE, before: SIGNED }, "deny"],
  ["signed: owner cannot delete it", { caller: owner, method: "delete", path: QTE, before: SIGNED }, "deny"],
  ["signed: collaborator cannot delete the draft invoice it was converted to", { caller: collaborator, method: "delete", path: QTE, before: { ...SIGNED, kind: "invoice", status: "draft", quoteNumber: "INV-2026-0031" } }, "deny"],
];

describe.skipIf(!haveCreds)("quote e-signature — firestore rules", () => {
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
