import { describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The daily api-cleanup deletes Resend email-id lookups (`emailEvents`) and
 * processed webhook svix-ids (`resendWebhookDeliveries`) past `expiresAt`,
 * and keeps the live ones. Real route over an in-memory Firestore.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true, publishCallback: async () => null }));
vi.mock("@/lib/server/agents-watchdog-service", () => ({ sweepOldWatchdogRuns: async () => 0 }));

const { runApiCleanup } = await import("./route");

describe("api-cleanup sweeps the Resend webhook collections", () => {
  it("deletes expired lookups and markers, keeps live ones", async () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    for (const c of ["emailEvents", "resendWebhookDeliveries"]) {
      mem.seed(`${c}/old`, { expiresAt: past });
      mem.seed(`${c}/live`, { expiresAt: future });
    }
    const out = await runApiCleanup();
    expect(out.ok).toBe(true);
    expect(out.results).toContainEqual({ collection: "emailEvents", deleted: 1, hitCap: false });
    expect(out.results).toContainEqual({ collection: "resendWebhookDeliveries", deleted: 1, hitCap: false });
    expect(mem.all().map((d) => d.path).filter((p) => !p.startsWith("agentProposals")).sort()).toEqual([
      "emailEvents/live",
      "resendWebhookDeliveries/live",
    ]);
  });
});
