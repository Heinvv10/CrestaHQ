import { readFileSync } from "node:fs";
import { cert } from "firebase-admin/app";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Evaluates the repo's OWN firestore.rules (not what is deployed) through the
 * Firebase Rules `projects:test` API — same harness as
 * `src/lib/audit/audit-events.firestore-rules.test.ts` (skips locally without
 * FIREBASE_ADMIN_*, FAILS in CI without them).
 *
 * Forms are edited via direct client-SDK writes (no server PATCH route), so
 * `formRedirectUrlValid()` in firestore.rules is the only server-side check
 * standing between a sub-account admin and a `javascript:`/`data:` value in
 * `settings.redirectUrl` — which the public form page then navigates the
 * browser to verbatim.
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

type Method = "create" | "update";
type Data = Record<string, unknown>;

interface Case {
  method: Method;
  /** The stored doc (absent for create). */
  before?: Data;
  /** The doc as it would be after the create/update. */
  after: Data;
}

const OWNER = { uid: "owner_a", agencyId: "agency_a" };

async function evaluate(cases: Case[]): Promise<{ allowed: boolean; errors: string[] }[]> {
  const { access_token } = await cert(creds as Required<typeof creds>).getAccessToken();
  const testCases = cases.map(({ method, before, after }) => ({
    expectation: "ALLOW",
    request: {
      path: `${DOCS}forms/form_1`,
      method,
      auth: {
        uid: OWNER.uid,
        token: { status: "active", agencyId: OWNER.agencyId, agencyRole: "owner" },
      },
      resource: { data: after },
    },
    resource: before ? { data: before } : null,
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

function form(redirectUrl: string | null) {
  return {
    agencyId: "agency_a",
    subAccountId: "sa_1",
    createdByUid: "owner_a",
    name: "Contact us",
    settings: {
      pipelineStageId: null,
      autoTags: [],
      thankYouMessage: "Thanks!",
      redirectUrl,
      createDeal: false,
      dealTitleTemplate: "",
      dealValue: 0,
      dealCurrency: "USD",
      appearance: { theme: "light", accent: "#000", hideChrome: false, hideTitle: false },
    },
  };
}

const CASES: [string, Case, "allow" | "deny"][] = [
  ["create with empty redirectUrl allowed", { method: "create", after: form("") }, "allow"],
  ["create with https redirectUrl allowed", { method: "create", after: form("https://example.com/thanks") }, "allow"],
  ["create with http redirectUrl allowed", { method: "create", after: form("http://example.com/thanks") }, "allow"],
  ["create with javascript: redirectUrl denied", { method: "create", after: form("javascript:alert(1)") }, "deny"],
  ["create with data: redirectUrl denied", { method: "create", after: form("data:text/html,<script>alert(1)</script>") }, "deny"],
  [
    "update to a javascript: redirectUrl denied",
    { method: "update", before: form(""), after: form("javascript:alert(document.cookie)") },
    "deny",
  ],
  [
    "update to an https redirectUrl allowed",
    { method: "update", before: form(""), after: form("https://example.com/thanks") },
    "allow",
  ],
];

describe.skipIf(!haveCreds)("forms.settings.redirectUrl firestore rules", () => {
  let results: { allowed: boolean; errors: string[] }[] = [];

  beforeAll(async () => {
    results = await evaluate(CASES.map(([, c]) => c));
  }, 30_000);

  it.each(CASES.map(([name, , outcome], i) => [name, outcome, i] as const))(
    "%s",
    (_name, outcome, i) => {
      const { allowed, errors } = results[i];
      expect(errors).toEqual([]);
      expect(allowed).toBe(outcome === "allow");
    }
  );
});
