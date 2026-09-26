import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "@/test/agent-proposals-harness";
import { seedPr13 } from "@/test/pr13-fixtures";

/** POST /broadcasts/email/send, now using lib/server/broadcast-start.ts: starts, and refuses, as before. */

const publishCallback = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ messageId: "q" })));
vi.mock("@/lib/automations/qstash", async (orig) => ({ ...((await orig()) as object), qstashIsConfigured: () => true, publishCallback }));
vi.mock("@/lib/firebase/admin", async () => ({
  ...(await (await import("@/test/agent-proposals-harness")).adminMock()),
  getAdminAuth: () => ({ getUser: async () => ({ displayName: "Admin", email: "admin@x.io" }) }),
}));
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());

const { POST } = await import("./route");
const send = (body: Record<string, unknown>) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify({ subAccountId: "sa1", templateId: "tpl_email", audienceFilter: { kind: "all" }, idempotencyKey: "key-12345", ...body }) }));

beforeEach(() => {
  mem.clear();
  publishCallback.mockClear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
  seedPr13(mem);
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Ann", email: "ann@x.io" });
});

describe("POST /broadcasts/email/send", () => {
  it("starts a person's broadcast (nothing approved on it) and is idempotent on its key", async () => {
    const res = await send({});
    expect(await res.json()).toMatchObject({ ok: true, broadcastId: "sa1_key-12345", audienceSize: 1 });
    expect(mem.read("broadcasts/sa1_key-12345")).toMatchObject({ status: "queued", createdBy: { displayName: "Admin", email: "admin@x.io" } });
    expect(mem.read("broadcasts/sa1_key-12345")).not.toHaveProperty("approved");
    expect(await (await send({})).json()).toMatchObject({ ok: true, duplicate: true });
  });

  it.each([
    ["broadcasts off", () => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, broadcastsEnabledByAgency: false }), 403],
    ["another sub-account's template", () => mem.seed("message_templates/tpl_email", { ...mem.read("message_templates/tpl_email")!, subAccountId: "sa2" }), 403],
    ["an empty audience", () => mem.seed("contacts/c1", { subAccountId: "sa2" }), 400],
  ])("%s -> %s, nothing started", async (_label, arrange, status) => {
    arrange();
    expect((await send({})).status).toBe(status);
    expect(mem.list("broadcasts")).toEqual([]);
  });
});
