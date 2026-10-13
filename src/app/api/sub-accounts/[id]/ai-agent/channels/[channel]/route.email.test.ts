import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Enabling the Email AI drafts channel: the sub-account's own agency gate
 * (`emailAiDraftsEnabledByAgency`, opt-in — undefined is off), a connected
 * mailbox (where the emails it drafts replies to arrive) and email sending
 * (how an approved draft goes out). Real tenancy guard + agent config over
 * in-memory Firestore. Turning it off is always allowed.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem, claims } = await import("@/test/gbp-sync-store");
const { PATCH } = await import("./route");

const SA = "sa1";
async function save(body: Record<string, unknown>) {
  const res = await PATCH(
    new Request(`https://app.test/api/sub-accounts/${SA}/ai-agent/channels/email`, {
      method: "PATCH",
      headers: { "x-user-uid": "admin", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SA, channel: "email" }) },
  );
  return { status: res.status, error: ((await res.json()) as { error?: string }).error };
}
const enabled = () => mem.read(`subAccounts/${SA}/aiAgent/email`)?.enabled;

const READY = {
  agencyId: "ag1",
  name: "One",
  emailAiDraftsEnabledByAgency: true,
  emailProvider: "smtp",
  smtpConfig: { host: "smtp.one.test", fromEmail: "hi@one.test", verifiedAt: "2026-10-01T00:00:00Z" },
  mailboxConfig: { enabled: true, verifiedAt: "2026-10-01T00:00:00Z" },
};

beforeEach(() => {
  mem.clear();
  vi.unstubAllEnvs();
  vi.stubEnv("RESEND_API_KEY", "");
  claims.set("admin", { status: "active", agencyId: "ag1" });
  mem.seed(`subAccounts/${SA}/subAccountMembers/admin`, { uid: "admin", role: "admin", status: "active" });
  mem.seed(`subAccounts/${SA}/aiAgent/profile`, { systemPrompt: "Be helpful." });
});

describe("PATCH channels/email — enabling", () => {
  it("is allowed with the gate on, a connected mailbox and email sending", async () => {
    mem.seed(`subAccounts/${SA}`, READY);
    expect((await save({ enabled: true })).status).toBe(200);
    expect(enabled()).toBe(true);
  });

  it.each([false, undefined])("is refused 403 while the agency gate is %s", async (gate) => {
    mem.seed(`subAccounts/${SA}`, { ...READY, emailAiDraftsEnabledByAgency: gate });
    const res = await save({ enabled: true });
    expect(res).toEqual({ status: 403, error: expect.stringContaining("Email AI drafts is disabled") });
    expect(enabled()).toBeUndefined();
  });

  it("is refused 400 without a connected mailbox", async () => {
    mem.seed(`subAccounts/${SA}`, { ...READY, mailboxConfig: { enabled: false, verifiedAt: "2026-10-01T00:00:00Z" } });
    expect(await save({ enabled: true })).toEqual({ status: 400, error: expect.stringContaining("Connect a mailbox") });
    expect(enabled()).toBeUndefined();
  });

  it("is refused 400 when the sub-account can't send email", async () => {
    mem.seed(`subAccounts/${SA}`, { ...READY, smtpConfig: { ...READY.smtpConfig, verifiedAt: "" } });
    expect(await save({ enabled: true })).toEqual({ status: 400, error: expect.stringContaining("Set up email sending") });
    expect(enabled()).toBeUndefined();
  });

  it("can always be turned off, even with the gate off", async () => {
    mem.seed(`subAccounts/${SA}`, { ...READY, emailAiDraftsEnabledByAgency: false });
    mem.seed(`subAccounts/${SA}/aiAgent/email`, { enabled: true, contextMessageCount: 10 });
    expect((await save({ enabled: false })).status).toBe(200);
    expect(enabled()).toBe(false);
  });
});
