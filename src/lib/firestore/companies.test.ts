import { expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ updateDoc: vi.fn(), doc: vi.fn() }));
vi.mock("firebase/firestore", () => ({
  addDoc: vi.fn(),
  collection: vi.fn(),
  doc: m.doc,
  onSnapshot: vi.fn(),
  query: vi.fn(),
  serverTimestamp: () => "ts",
  updateDoc: m.updateDoc,
  where: vi.fn(),
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
import { updateCompany } from "./companies";

it("renaming a company writes the company doc only — linked contacts keep the name copied at link time", async () => {
  m.doc.mockReturnValue({ path: "companies/co1" });
  await updateCompany("co1", { name: "Acme Ltd" });
  expect(m.doc).toHaveBeenCalledWith({}, "companies", "co1");
  expect(m.updateDoc).toHaveBeenCalledTimes(1);
  expect(m.updateDoc).toHaveBeenCalledWith(
    { path: "companies/co1" },
    { name: "Acme Ltd", updatedAt: "ts" },
  );
});
