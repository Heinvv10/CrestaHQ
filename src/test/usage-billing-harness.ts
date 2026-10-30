import { afterEach, beforeEach, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { restoreBillingProviderAfterEach } from "@/test/billing-provider-spies";
import { flushAfterResponse } from "@/lib/server/after-response";

/**
 * Shared setup for the usage-billing close tests (usage-billing.*.test.ts):
 * the in-memory Firestore, the mail spy, the fixture docs and the readers.
 * Each test file still declares its own `vi.mock` calls (they must be hoisted
 * in the file that uses them) and points them at `mem` and `mail` here.
 */

export const mem = createMemoryFirestore();
export const mail = {
  send: vi.fn(async (..._a: unknown[]) => ({})),
  sender: { kind: "shared" } as { kind: "shared" } | null,
};

/** 05:00 on the 1st, server-local: the daily job's first run of October. */
export const NOW = new Date(2026, 9, 1, 5, 0);
export const CHARGE = "usage_sa1_2026-09";
export const EMAIL = "client@example.com";

export const SUB = {
  agencyId: "ag1",
  name: "Client One",
  usageRebillingEnabled: true,
  usageRebillingSince: new Date(2026, 7, 1),
  usageQuotas: { emailsPerMonth: 100 },
  usageRates: { emailCents: 10 },
  billing: { currency: "zar" },
  accountContact: { email: EMAIL },
};
export const AGENCY = { ownerUid: "own", usageRebillingEnabled: true, usageRebillingSince: new Date(2026, 7, 1) };

/** The pay link in each email sent so far (the system email's button). */
export const payUrlsSent = () =>
  mail.send.mock.calls.map((c) => String(((c[1] as { text: string }).text.match(/https:\/\/\S+\/pay\/charge\/\S+/) ?? [""])[0]));
export const events = async (event: string) => {
  await flushAfterResponse();
  return mem.list("billingEvents").filter((e) => e.event === event);
};
export const charges = () => mem.list("billingCharges");
export const queue = () => mem.list("usagePendingCharges");
export const frozen = (month = "2026-09") =>
  (mem.read(`subAccounts/sa1/usage/${month}`)?.closed as Record<string, unknown> | undefined) ?? undefined;

/** Registers the per-test reset: empty store, the three fixture docs, env, quiet console. */
export function setupUsageBillingTests() {
  restoreBillingProviderAfterEach();
  beforeEach(() => {
    mem.clear();
    mail.send.mockClear();
    mail.sender = { kind: "shared" };
    vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "x".repeat(32));
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mem.seed("agencies/ag1", AGENCY);
    mem.seed("subAccounts/sa1", SUB);
    // 600 emails against 100 included at 10c: 500 over = 5,000c.
    mem.seed("subAccounts/sa1/usage/2026-09", { emailsSent: 600 });
  });
  afterEach(() => vi.unstubAllEnvs());
}
