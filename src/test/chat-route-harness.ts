import { vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The in-app assistant's real chat and confirm routes over an in-memory
 * Firestore, with auth and the model call stubbed (as website-cta.test.ts
 * does inline). A test file wires it with:
 *
 *   vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
 *   vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
 *   vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
 *   vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
 *   vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));
 */

export const mem = createMemoryFirestore();
/** The caller's sub-account role ("admin", "collaborator", "agencyOwner"). */
export const role = { current: "admin" };
export const runAiSuiteTurn = vi.fn();

export const adminMock = () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async () => ({ email: "admin@acme.test" }) }),
});
export const tenancyMock = () => ({
  requireSubAccountMember: async () => ({ uid: "u1", email: "a@example.com", agencyId: "ag1", subAccountRole: role.current }),
  requireAgencyOwnerAny: async () => ({ uid: "owner1", email: "o@example.com", agencyId: "ag1" }),
});
export const modelMock = () => ({
  aiSuiteIsConfigured: () => true,
  aiSuiteModel: () => "test-model",
  normalizeAiSuiteModelChoice: () => "opus",
  runAiSuiteTurn: (input: unknown) => runAiSuiteTurn(input),
});

const post = (body: unknown) => new Request("http://localhost/api/ai-suite", { method: "POST", body: JSON.stringify(body) });

/** The model calls `name` with `args` in sa1, then answers "done". */
export async function ask(name: string, args: Record<string, unknown>) {
  runAiSuiteTurn.mockResolvedValueOnce({ text: "", toolCall: { id: "call_1", name, args } });
  runAiSuiteTurn.mockResolvedValueOnce({ text: "done", toolCall: null });
  const chat = await import("@/app/api/ai-suite/chat/route");
  return chat.POST(post({ level: "sub-account", subAccountId: "sa1", messages: [{ role: "user", content: "go" }] }));
}

/** What the chat route fed back to the model for the lookup `ask` ran. */
export function lookupResult(): string {
  const second = runAiSuiteTurn.mock.calls[1]?.[0] as { messages: Array<{ role: string; content: string }> } | undefined;
  return second?.messages.at(-1)?.role === "tool" ? second.messages.at(-1)!.content : "(no lookup ran)";
}

/** The confirm card's POST, for a sa1 capability. */
export async function doConfirm(capability: string, args: Record<string, unknown>) {
  const confirm = await import("@/app/api/ai-suite/confirm/route");
  return confirm.POST(post({ level: "sub-account", subAccountId: "sa1", capability, args }));
}

/** Gates and tenancy docs every test starts from: two sub-accounts in ag1. */
export function seedTenants(gates: Record<string, unknown> = {}) {
  mem.clear();
  role.current = "admin";
  runAiSuiteTurn.mockReset();
  const base = { agencyId: "ag1", aiSuiteEnabledByAgency: true, timezone: "UTC", ...gates };
  mem.seed("agencies/ag1", { ownerUid: "owner1", agencyAssistantEnabled: true });
  mem.seed("subAccounts/sa1", { ...base, name: "W" });
  mem.seed("subAccounts/sa2", { ...base, name: "Other" });
}
