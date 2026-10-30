import { describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The daily api-cleanup deletes `agent.call` rows past their 30-day
 * `expiresAt` from every agency (a collection-group sweep) and keeps the
 * rest. Real route over an in-memory Firestore; QStash and the watchdog
 * sweep stubbed.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true, publishCallback: async () => null }));
vi.mock("@/lib/server/agents-watchdog-service", () => ({ sweepOldWatchdogRuns: async () => 0 }));

const { runApiCleanup } = await import("./route");

describe("api-cleanup sweeps agentCalls", () => {
  it("deletes expired rows in every agency, keeps live ones", async () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    mem.seed("agencies/ag1/agentCalls/old", { tool: "find_contacts", expiresAt: past });
    mem.seed("agencies/ag2/agentCalls/old", { tool: "find_contacts", expiresAt: past });
    mem.seed("agencies/ag1/agentCalls/live", { tool: "find_contacts", expiresAt: future });
    const out = await runApiCleanup();
    expect(out.ok).toBe(true);
    expect(out.results).toContainEqual({ collection: "agentCalls", deleted: 2, hitCap: false });
    expect(mem.all().map((d) => d.path).filter((p) => p.includes("/agentCalls/"))).toEqual(["agencies/ag1/agentCalls/live"]);
  });
});
