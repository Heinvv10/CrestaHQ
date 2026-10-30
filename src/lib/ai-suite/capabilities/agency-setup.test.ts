import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askAgency, lookupResult, mem, runAiSuiteTurn, seedTenants } from "@/test/chat-route-harness";
import { KNOWN_KEYS } from "@/lib/setup/catalog";

/**
 * deployment_setup_status (N2b) through the real Agency Assistant chat
 * route: what it feeds the model carries each integration's title and
 * status, never a value or a key name — even when a value is malformed in
 * a way the catalog's own checks would quote back — and it counts this
 * agency's verified SMTP senders as email, as the Get-started banner does.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));

const { availableOn, getCapability } = await import("@/lib/ai-suite/capabilities");

const sentinel = (k: string) => `SENTINEL_VALUE_${k}_9f3a`;
const smtp = { emailProvider: "smtp", smtpConfig: { host: "mail.example.com", fromEmail: "hi@example.com", verifiedAt: "2026-10-01T00:00:00Z" } };

async function status() {
  // lookupResult reads the turn after this ask's own lookup.
  runAiSuiteTurn.mockReset();
  await askAgency("deployment_setup_status", {});
  return lookupResult();
}

beforeEach(() => {
  seedTenants();
  for (const k of KNOWN_KEYS) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("deployment_setup_status", () => {
  it("never carries a value or a key name, every key set (the Firebase checks quote their values back)", async () => {
    for (const k of KNOWN_KEYS) vi.stubEnv(k, sentinel(k));
    const out = await status();
    expect(out).toContain("Required to run:");
    expect(out).not.toContain("SENTINEL_VALUE_");
    for (const k of KNOWN_KEYS) expect(out, k).not.toContain(k);
  });

  it("never carries a key name with nothing set, and lists the groups by title", async () => {
    const out = await status();
    expect(out).toContain("✗ Firebase");
    expect(out).toContain("○ Client Billing on Paystack (South Africa)");
    for (const k of KNOWN_KEYS) expect(out, k).not.toContain(k);
  });

  it("email: off with nothing; configured by a verified SMTP sub-account of this agency, not another's", async () => {
    expect(await status()).toMatch(/○ Email\b/);
    mem.seed("subAccounts/sb1", { agencyId: "ag2", ...smtp });
    expect(await status()).toMatch(/○ Email\b/);
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, ...smtp });
    expect(await status()).toMatch(/✓ Email\b/);
  });

  it("is a chat-only read", () => {
    const cap = getCapability("deployment_setup_status")!;
    expect(cap.readonly).toBe(true);
    expect(availableOn(cap, "agent")).toBe(false);
  });
});
