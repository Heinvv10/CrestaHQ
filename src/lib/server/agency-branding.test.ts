import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  agencyHeader: null as string | null,
  get: vi.fn(),
  docPath: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(m.agencyHeader ? { "x-agency-id": m.agencyHeader } : {}),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => {
      m.docPath(path);
      return { get: m.get };
    },
  }),
}));

import { getInitialAgencyBranding } from "./agency-branding";

beforeEach(() => {
  m.agencyHeader = null;
  m.get.mockReset();
  m.docPath.mockReset();
  vi.restoreAllMocks();
});

it("returns only the three public branding fields of the header's agency", async () => {
  m.agencyHeader = "ag-fields";
  m.get.mockResolvedValue({
    exists: true,
    data: () => ({
      name: "Acme Agency",
      logoUrl: "https://cdn.example/logo.png",
      appTheme: "green",
      supportEmail: "secret@example.com",
      ownerUid: "owner-1",
      stripeCustomerId: "cus_1",
    }),
  });
  await expect(getInitialAgencyBranding()).resolves.toEqual({
    name: "Acme Agency",
    logoUrl: "https://cdn.example/logo.png",
    appTheme: "green",
  });
  expect(m.docPath).toHaveBeenCalledWith("agencies/ag-fields");
});

it("normalises missing fields to null", async () => {
  m.agencyHeader = "ag-empty";
  m.get.mockResolvedValue({ exists: true, data: () => ({}) });
  await expect(getInitialAgencyBranding()).resolves.toEqual({
    name: null,
    logoUrl: null,
    appTheme: null,
  });
});

it("returns null without reading Firestore when the header is absent", async () => {
  await expect(getInitialAgencyBranding()).resolves.toBeNull();
  expect(m.get).not.toHaveBeenCalled();
});

it("returns null when the agency doc does not exist", async () => {
  m.agencyHeader = "gone";
  m.get.mockResolvedValue({ exists: false, data: () => undefined });
  await expect(getInitialAgencyBranding()).resolves.toBeNull();
});

it("fails open to null and logs when Firestore throws", async () => {
  m.agencyHeader = "ag-throws";
  m.get.mockRejectedValue(new Error("UNAVAILABLE"));
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(getInitialAgencyBranding()).resolves.toBeNull();
  expect(err).toHaveBeenCalledTimes(1);
});

/**
 * No cross-request cache: a hard load right after the owner changes their
 * logo must seed the NEW logo, or the old one flashes — the bug this fixes.
 */
it("a second request after the doc changes returns the new branding", async () => {
  m.agencyHeader = "ag-changed";
  m.get.mockResolvedValueOnce({ exists: true, data: () => ({ logoUrl: "https://cdn.example/old.png" }) });
  await expect(getInitialAgencyBranding()).resolves.toMatchObject({ logoUrl: "https://cdn.example/old.png" });
  m.get.mockResolvedValueOnce({ exists: true, data: () => ({ logoUrl: "https://cdn.example/new.png" }) });
  await expect(getInitialAgencyBranding()).resolves.toMatchObject({ logoUrl: "https://cdn.example/new.png" });
  expect(m.get).toHaveBeenCalledTimes(2);
});
