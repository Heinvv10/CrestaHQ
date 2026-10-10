import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * forms-service is the Admin-SDK twin of the Forms page's createForm: for
 * each preset, the doc it writes must equal the one the UI path writes
 * (driven through the real client helper with the client SDK stubbed), and
 * it carries the tenant keys from the sub-account doc.
 */

const mem = createMemoryFirestore();
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const ui = vi.hoisted(() => ({ written: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  collection: () => ({}),
  serverTimestamp: () => "SERVER_TIMESTAMP",
  addDoc: async (_ref: unknown, data: Record<string, unknown>) => {
    ui.written.push(data);
    return { id: "ui1" };
  },
}));

const { createForm } = await import("@/lib/firestore/forms");
const {
  createFormServerSide,
  FormServiceError,
  formEmbedSnippet,
  formPublicUrl,
  getFormForSubAccount,
  listFormsForSubAccount,
} = await import("./forms-service");

const withoutTimes = (d: Record<string, unknown>) => {
  const { createdAt: _c, updatedAt: _u, ...rest } = d;
  return rest;
};

beforeEach(() => {
  mem.clear();
  ui.written.length = 0;
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "W" });
  mem.seed("subAccounts/sa2", { agencyId: "ag2", name: "Other" });
});

describe("createFormServerSide", () => {
  it.each(["contact", "blank"] as const)(
    "the %s preset writes the same doc as the Forms page",
    async (template) => {
      await createForm({ agencyId: "ag1", subAccountId: "sa1" }, "u1", "Free quote", template);
      const id = await createFormServerSide({ subAccountId: "sa1", createdByUid: "u1", name: "Free quote", template });
      const server = mem.read(`forms/${id}`)!;
      expect(ui.written).toHaveLength(1);
      expect(withoutTimes(server)).toEqual(withoutTimes(ui.written[0]!));
      // Both stamp the times (server-side timestamps on each path).
      expect(server.createdAt).toBeInstanceOf(Date);
      expect(server.updatedAt).toBeInstanceOf(Date);
      expect(ui.written[0]).toMatchObject({ createdAt: "SERVER_TIMESTAMP", updatedAt: "SERVER_TIMESTAMP" });
    },
  );

  it("defaults to the blank preset, like the UI helper", async () => {
    await createForm({ agencyId: "ag1", subAccountId: "sa1" }, "u1", "Default");
    const id = await createFormServerSide({ subAccountId: "sa1", createdByUid: "u1", name: "Default" });
    expect(withoutTimes(mem.read(`forms/${id}`)!)).toEqual(withoutTimes(ui.written[0]!));
  });

  it("carries the tenant keys from the sub-account doc", async () => {
    const id = await createFormServerSide({ subAccountId: "sa2", createdByUid: "u9", name: "Contact us", template: "contact" });
    expect(mem.read(`forms/${id}`)).toMatchObject({
      agencyId: "ag2",
      subAccountId: "sa2",
      createdByUid: "u9",
      slug: "contact-us",
      enabled: true,
      submissionCount: 0,
    });
  });

  it("refuses a missing sub-account, one without an agency, and an empty name", async () => {
    await expect(createFormServerSide({ subAccountId: "nope", createdByUid: "u1", name: "X" })).rejects.toBeInstanceOf(FormServiceError);
    mem.seed("subAccounts/sa3", { name: "No agency" });
    await expect(createFormServerSide({ subAccountId: "sa3", createdByUid: "u1", name: "X" })).rejects.toBeInstanceOf(FormServiceError);
    await expect(createFormServerSide({ subAccountId: "sa1", createdByUid: "u1", name: "   " })).rejects.toBeInstanceOf(FormServiceError);
    expect(mem.list("forms")).toEqual([]);
  });
});

describe("reads stay in the sub-account", () => {
  beforeEach(() => {
    mem.seed("forms/f1", { name: "Old", subAccountId: "sa1", agencyId: "ag1", createdAt: new Date(1000) });
    mem.seed("forms/f2", { name: "New", subAccountId: "sa1", agencyId: "ag1", createdAt: new Date(2000) });
    mem.seed("forms/f3", { name: "Theirs", subAccountId: "sa2", agencyId: "ag2", createdAt: new Date(3000) });
  });

  it("listFormsForSubAccount returns only this sub-account's forms, newest first", async () => {
    expect((await listFormsForSubAccount("sa1")).map((f) => f.id)).toEqual(["f2", "f1"]);
  });

  it("getFormForSubAccount refuses another sub-account's form", async () => {
    expect(await getFormForSubAccount("sa1", "f3")).toBeNull();
    expect(await getFormForSubAccount("sa1", "missing")).toBeNull();
    expect((await getFormForSubAccount("sa2", "f3"))?.name).toBe("Theirs");
  });
});

it("public URL and embed snippet use the app URL and the hosted /f/ page", () => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com/");
  expect(formPublicUrl("f1")).toBe("https://crm.example.com/f/f1");
  expect(formEmbedSnippet("f1")).toContain('src="https://crm.example.com/f/f1?embed=1"');
  vi.unstubAllEnvs();
});
