import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
afterEach(() => {
  vi.useRealTimers();
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
 * Cross-request TTL cache (60 s, per agency id) in front of the Admin read,
 * so hard loads of dashboard routes don't each cost a Firestore read.
 */
const DOC = { exists: true, data: () => ({ name: "Cached Agency" }) };

it("a second call within the TTL does not read Firestore again", async () => {
  vi.useFakeTimers();
  m.agencyHeader = "ag-ttl-hit";
  m.get.mockResolvedValue(DOC);
  await getInitialAgencyBranding();
  vi.advanceTimersByTime(59_000);
  await expect(getInitialAgencyBranding()).resolves.toMatchObject({ name: "Cached Agency" });
  expect(m.get).toHaveBeenCalledTimes(1);
});

it("reads again once the TTL has passed", async () => {
  vi.useFakeTimers();
  m.agencyHeader = "ag-ttl-expire";
  m.get.mockResolvedValue(DOC);
  await getInitialAgencyBranding();
  vi.advanceTimersByTime(61_000);
  await getInitialAgencyBranding();
  expect(m.get).toHaveBeenCalledTimes(2);
});

it("keys the cache by agency id", async () => {
  m.get.mockResolvedValue(DOC);
  m.agencyHeader = "ag-key-a";
  await getInitialAgencyBranding();
  m.agencyHeader = "ag-key-b";
  await getInitialAgencyBranding();
  expect(m.get).toHaveBeenCalledTimes(2);
});

it("does not cache a failed read — the next request retries", async () => {
  m.agencyHeader = "ag-retry";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  m.get.mockRejectedValueOnce(new Error("UNAVAILABLE")).mockResolvedValue(DOC);
  await expect(getInitialAgencyBranding()).resolves.toBeNull();
  await expect(getInitialAgencyBranding()).resolves.toMatchObject({ name: "Cached Agency" });
  expect(m.get).toHaveBeenCalledTimes(2);
});
