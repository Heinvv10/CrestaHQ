import { describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * Every direct (non-approval) agent write leaves one `agent.write` audit row
 * from dispatchAgentTool: the key as actor, the capability and key prefix,
 * the record touched, and the NAMES of the args — never their values. Read
 * tools leave none, and their responses are kept out of request logs.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

const { dispatchAgentTool } = await import("./agent-dispatch");
const { toolLogResponseBody } = await import("./agent-audit");

setupAgentProposalTests();

describe("agent.write audit rows", () => {
  it("a direct write records the key, capability, target and redacted arg names", async () => {
    const r = await dispatchAgentTool(auth, "create_contact", { name: "Ann Secret", email: "ann@secret.io" });
    const id = (r as { ref: { id: string } }).ref.id;
    const [row] = mem.list("auditEvents");
    expect(row).toMatchObject({
      action: "agent.write",
      actor: { type: "api_key", id: "key1" },
      target: { type: "contact", id },
      agencyId: "ag1",
      subAccountId: "sa1",
    });
    expect(row!.changes).toEqual(
      expect.arrayContaining([
        { field: "capability", before: null, after: "create_contact" },
        { field: "keyPrefix", before: null, after: "abcd1234" },
        { field: "args.name", before: null, after: "[redacted]" },
        { field: "args.email", before: null, after: "[redacted]" },
      ])
    );
    expect(JSON.stringify(row)).not.toContain("Ann Secret");
    expect(JSON.stringify(row)).not.toContain("ann@secret.io");
  });

  it("a read tool records nothing", async () => {
    await dispatchAgentTool(auth, "find_contacts", { query: "ann" });
    expect(mem.list("auditEvents")).toEqual([]);
  });

  it("an approval capability records nothing at propose time (the approve path audits)", async () => {
    await dispatchAgentTool(auth, "__test_outbound", { body: "hi" });
    expect(mem.list("auditEvents")).toEqual([]);
  });
});

describe("request-log body redaction for read tools", () => {
  it("a read tool's response is not kept; a write's is", () => {
    expect(toolLogResponseBody({ readonly: true }, { contacts: ["Ann"] })).toBeNull();
    expect(toolLogResponseBody({ readonly: false }, { id: "c1" })).toEqual({ id: "c1" });
  });
});
