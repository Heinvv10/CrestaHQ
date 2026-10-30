import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The AI Suite's create_webhook / update_webhook_url must apply the same
 * DNS-resolving destination rule as the REST routes. Their sync validate()
 * only sees the string, so a public-looking name pointing at an internal
 * address has to be refused inside execute(), before anything is stored or
 * sent.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
const createSubscription = vi.fn();
const updateSubscription = vi.fn();
vi.mock("@/lib/firestore/webhook-subscriptions", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createSubscription: (...a: unknown[]) => createSubscription(...a),
  updateSubscription: (...a: unknown[]) => updateSubscription(...a),
  getSubscription: async () => ({ id: "s1", url: "https://old.example.com/", status: "active" }),
}));
const sendDirectTestDelivery = vi.fn();
vi.mock("@/lib/webhooks/direct-test", () => ({
  sendDirectTestDelivery: (...a: unknown[]) => sendDirectTestDelivery(...a),
}));
vi.mock("node:dns/promises", async () =>
  (await import("@/test/fake-resolver")).fakeDnsModule((host, family) =>
    host === "internal.example.com" && family === 4 ? ["100.96.203.105"] : undefined,
  ),
);

const { getCapability } = await import("./capabilities");

const ctx = {
  uid: "u1", email: "a@example.com", displayName: "A", agencyId: "ag1",
  subAccountId: "sa1", subAccountRole: "admin",
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true });
  createSubscription.mockReset();
  updateSubscription.mockReset();
  sendDirectTestDelivery.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("AI Suite webhook capabilities — SSRF guard", () => {
  it("create_webhook refuses a name resolving to an internal address", async () => {
    await expect(
      getCapability("create_webhook")!.execute(ctx, {
        url: "https://internal.example.com/hook",
        events: ["contact.created"],
        description: "",
        mode: "live",
      }),
    ).rejects.toThrow(/private or internal/);
    expect(createSubscription).not.toHaveBeenCalled();
    expect(sendDirectTestDelivery).not.toHaveBeenCalled();
  });

  it("update_webhook_url refuses a name resolving to an internal address", async () => {
    await expect(
      getCapability("update_webhook_url")!.execute(ctx, {
        webhookId: "s1",
        currentUrl: "https://old.example.com/",
        newUrl: "https://internal.example.com/hook",
        switchToN8nProduction: false,
      }),
    ).rejects.toThrow(/private or internal/);
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(sendDirectTestDelivery).not.toHaveBeenCalled();
  });
});
