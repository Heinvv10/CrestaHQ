import { beforeAll, describe, expect, it } from "vitest";

/**
 * The fixture guard is the only thing standing between a spec bug and the
 * production Firestore this suite runs against, so it gets a real test rather
 * than a comment claiming it works. Both cases below fail if the guard is
 * softened into a warn-and-continue.
 */

// Dummy values — nothing here touches Firebase. env.ts requires the full set
// to be present, so the whole contract is filled in.
beforeAll(() => {
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "test-api-key";
  process.env.FIREBASE_ADMIN_PROJECT_ID = "test-project";
  process.env.FIREBASE_ADMIN_CLIENT_EMAIL = "test@example.com";
  process.env.FIREBASE_ADMIN_PRIVATE_KEY = "test-key";
  process.env.E2E_EMAIL = "e2e@example.com";
  process.env.E2E_PASSWORD = "test-password";
  process.env.E2E_AGENCY_ID = "agency-e2e";
  process.env.E2E_SUBACCOUNT_ID = "fixture-primary";
  process.env.E2E_SUBACCOUNT_ID_SECONDARY = "fixture-secondary";
  process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_test";
});

describe("assertFixtureScope", () => {
  it("throws on a foreign subAccountId", async () => {
    const { assertFixtureScope } = await import("./guard");
    expect(() =>
      assertFixtureScope("contacts/abc", { subAccountId: "blitz-fibre-live" }),
    ).toThrow(/not a fixture sub-account/);
  });

  it("throws when subAccountId is missing", async () => {
    const { assertFixtureScope } = await import("./guard");
    expect(() => assertFixtureScope("contacts/abc", { name: "Jane" })).toThrow(
      /no subAccountId/,
    );
    expect(() => assertFixtureScope("contacts/abc", undefined)).toThrow(
      /no subAccountId/,
    );
  });

  it("accepts both fixture sub-accounts", async () => {
    const { assertFixtureScope } = await import("./guard");
    expect(() =>
      assertFixtureScope("contacts/abc", { subAccountId: "fixture-primary" }),
    ).not.toThrow();
    expect(() =>
      assertFixtureScope("contacts/abc", { subAccountId: "fixture-secondary" }),
    ).not.toThrow();
  });
});
