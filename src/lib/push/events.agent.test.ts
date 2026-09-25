import { beforeEach, expect, it, vi } from "vitest";

/** Staff push for contact.created: a human-made contact shows its name and
 *  source; an API agent's shows fixed copy only, never agent-chosen text. */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
const sendPushForEvent = vi.fn(async (_input: Record<string, unknown>) => undefined);
vi.mock("@/lib/push/send", () => ({ sendPushForEvent }));

const { dispatchPushForWebhookEvent, AGENT_CONTACT_PUSH_BODY } = await import("./events");

const event = (byAgent?: boolean) => ({
  subAccountId: "sa1", agencyId: "ag1", mode: "live" as const, type: "contact.created" as const,
  payload: { contact: { id: "c1", name: "Ann Agentname", source: "website-form" } },
  ...(byAgent === undefined ? {} : { byAgent }),
});

beforeEach(() => sendPushForEvent.mockClear());

it("human path unchanged: name + source", async () => {
  await dispatchPushForWebhookEvent(event());
  expect(sendPushForEvent).toHaveBeenCalledWith(expect.objectContaining({ title: "New lead", body: "Ann Agentname · Website form" }));
});

it("agent path: fixed copy, no agent text", async () => {
  await dispatchPushForWebhookEvent(event(true));
  const [push] = sendPushForEvent.mock.calls[0]!;
  expect(push).toMatchObject({ title: "New contact", body: AGENT_CONTACT_PUSH_BODY, url: "/sa/sa1/contacts/c1" });
  expect(JSON.stringify(push)).not.toContain("Agentname");
});
