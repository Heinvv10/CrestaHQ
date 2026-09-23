import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In vapi-managed mode the pasted phone-number id points into the
 * deployment's ONE shared Vapi account. Saving it rebinds that line to this
 * sub-account's assistant, so choosing which number a sub-account gets is the
 * agency owner's call — a sub-account admin must not be able to claim any
 * number in the account. Real tenancy guard + agent config over in-memory
 * Firestore; only the Vapi HTTP client is faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/voice/vapi", () => ({
  vapiIsConfigured: () => true,
  vapiPhoneNumberExists: async () => true,
  bindVapiAssistantToPhoneNumber: vi.fn(),
  deleteVapiAssistant: vi.fn(),
  deleteVapiPhoneNumber: vi.fn(),
  ensureVapiAssistant: vi.fn(),
  ensureVapiPhoneNumber: vi.fn(),
  unbindVapiPhoneNumber: vi.fn(),
  VapiError: class extends Error {},
}));

const { mem, claims } = await import("@/test/gbp-sync-store");
const { PATCH } = await import("./route");

const SA = "sa1";
function save(uid: string, voice: Record<string, unknown>) {
  return PATCH(
    new Request(`https://app.test/api/sub-accounts/${SA}/ai-agent/channels/voice`, {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify({ voice }),
    }),
    { params: Promise.resolve({ id: SA, channel: "voice" }) },
  );
}
const storedNumber = () =>
  (mem.read(`subAccounts/${SA}/aiAgent/voice`)?.voice as { vapiPhoneNumberId?: string } | undefined)
    ?.vapiPhoneNumberId ?? null;

beforeEach(() => {
  mem.clear();
  claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  claims.set("admin", { status: "active", agencyId: "ag1" });
  mem.seed(`subAccounts/${SA}`, { agencyId: "ag1", name: "One" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/admin`, { uid: "admin", role: "admin", status: "active" });
});

describe("PATCH voice — vapi-managed phone number", () => {
  it("refuses a sub-account admin attaching a number, and stores nothing", async () => {
    const res = await save("admin", { numberMode: "vapi-managed", vapiPhoneNumberId: "pn-someone-elses" });
    expect(res.status).toBe(403);
    expect(storedNumber()).toBeNull();
  });

  it("lets the agency owner attach it", async () => {
    const res = await save("owner", { numberMode: "vapi-managed", vapiPhoneNumberId: "pn-assigned" });
    expect(res.status).toBe(200);
    expect(storedNumber()).toBe("pn-assigned");
  });

  it("still lets the sub-account admin save other voice settings once the owner attached a number", async () => {
    await save("owner", { numberMode: "vapi-managed", vapiPhoneNumberId: "pn-assigned" });
    const res = await save("admin", { numberMode: "vapi-managed", vapiPhoneNumberId: "pn-assigned", maxCallSeconds: 300 });
    expect(res.status).toBe(200);
    expect(storedNumber()).toBe("pn-assigned");
  });
});
