import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async (_req: Request, subAccountId: string) => ({
    uid: "u1",
    email: "a@x.io",
    agencyId: "ag1",
    subAccountId,
    subAccountRole: "collaborator",
  }),
}));

const { GET } = await import("./route");
const list = (query = "") =>
  GET(new Request(`http://localhost/x${query}`), { params: Promise.resolve({ id: "sa1" }) });

beforeEach(() => {
  mem.clear();
  mem.seed("agentProposals/p1", { subAccountId: "sa1", status: "pending", rev: "r1", createdAt: new Date(1) });
  mem.seed("agentProposals/p2", { subAccountId: "sa1", status: "rejected", createdAt: new Date(2) });
  mem.seed("agentProposals/p3", { subAccountId: "sa2", status: "pending", createdAt: new Date(3) });
});

it("lists only this sub-account's proposals, newest first, optionally by status", async () => {
  const ids = async (q?: string) =>
    ((await (await list(q)).json()) as { proposals: { id: string }[] }).proposals.map((p) => p.id);
  expect(await ids()).toEqual(["p2", "p1"]);
  expect(await ids("?status=pending")).toEqual(["p1"]);
  // The approvals page must send back the generation it rendered.
  const [p1] = ((await (await list("?status=pending")).json()) as { proposals: { rev: string }[] }).proposals;
  expect(p1!.rev).toBe("r1");
  expect((await list("?status=bogus")).status).toBe(400);
});

it("hides rows whose contact is outside a scoped collaborator's territories; rows with no contact stay", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1", territoryScopingEnabled: true });
  mem.seed("subAccounts/sa1/subAccountMembers/u1", { role: "collaborator", assignedTerritoryIds: ["north"] });
  mem.seed("contacts/cn", { subAccountId: "sa1", territoryId: "north" });
  mem.seed("contacts/cs", { subAccountId: "sa1", territoryId: "south" });
  mem.seed("agentProposals/p4", { subAccountId: "sa1", status: "pending", contactId: "cn", createdAt: new Date(4) });
  mem.seed("agentProposals/p5", { subAccountId: "sa1", status: "pending", contactId: "cs", createdAt: new Date(5) });
  const res = (await (await list()).json()) as { proposals: { id: string }[] };
  expect(res.proposals.map((p) => p.id)).toEqual(["p4", "p2", "p1"]);
});
