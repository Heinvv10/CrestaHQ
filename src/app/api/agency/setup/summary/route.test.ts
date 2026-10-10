import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { KNOWN_KEYS } from "@/lib/setup/catalog";

/**
 * The setup summary feeds the owner's setup-snapshot dialog. `groups[]` must
 * carry titles, tiers, statuses and the catalog's own "off" copy only — never
 * an env key name or a value. Real route over an in-memory Firestore; the
 * owner gate is the only thing stubbed.
 */

let mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireAgencyOwnerAny: async () => ({ uid: "owner1", agencyId: "ag1" }),
}));

const { GET } = await import("./route");

const call = async () => {
  const res = await GET(new Request("http://x/api/agency/setup/summary"));
  const text = await res.text();
  return { text, body: JSON.parse(text) };
};

const sentinel = (k: string) => `SENTINEL_VALUE_${k}_9f3a`;

beforeEach(() => {
  mem = createMemoryFirestore();
  for (const k of KNOWN_KEYS) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/agency/setup/summary groups", () => {
  it("never carries a secret value or an env key name", async () => {
    for (const k of KNOWN_KEYS) vi.stubEnv(k, sentinel(k));
    const { text, body } = await call();

    expect(body.groups.length).toBeGreaterThan(5);
    expect(text).not.toContain("SENTINEL_VALUE_");
    for (const k of KNOWN_KEYS) expect(text).not.toContain(k);
    for (const g of body.groups) {
      expect(Object.keys(g).sort()).toEqual(["off", "status", "tier", "title"]);
    }
  });

  it("lists the Paystack, WhatsApp and Google groups under our names", async () => {
    const { body } = await call();
    const titles = body.groups.map((g: { title: string }) => g.title);
    expect(titles).toContain("Client Billing on Paystack (South Africa)");
    expect(titles).toContain("WhatsApp bridge fleet (wa-manager)");
    expect(titles).toContain("Google (Business Profile + Calendar)");
    expect(titles).toContain("Email");
    expect(titles).not.toContain("Email (Resend)");
  });

  it("reports Google configured from GOOGLE_CLIENT_ID/SECRET", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const { body } = await call();
    const g = body.groups.find((x: { title: string }) => x.title.startsWith("Google ("));
    expect(g.status).toBe("ok");
  });
});

describe("GET /api/agency/setup/summary Email row", () => {
  const emailStatus = async () =>
    (await call()).body.groups.find((g: { title: string }) => g.title === "Email").status;
  const smtp = (verified: boolean) => ({
    emailProvider: "smtp",
    smtpConfig: {
      host: "mail.example.com",
      fromEmail: "hi@example.com",
      ...(verified ? { verifiedAt: "2026-10-01T00:00:00Z" } : {}),
    },
  });

  it("is not set up with no Resend env and no SMTP sub-account", async () => {
    expect(await emailStatus()).toBe("off");
  });

  it("is configured by Resend env alone", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_x");
    vi.stubEnv("EMAIL_FROM", "a@b.co");
    expect(await emailStatus()).toBe("ok");
  });

  it("is configured by a verified SMTP sub-account of this agency", async () => {
    mem.seed("subAccounts/s1", { agencyId: "ag1", ...smtp(true) });
    expect(await emailStatus()).toBe("ok");
  });

  it("ignores unverified SMTP and other agencies' SMTP", async () => {
    mem.seed("subAccounts/s1", { agencyId: "ag1", ...smtp(false) });
    mem.seed("subAccounts/s2", { agencyId: "other", ...smtp(true) });
    expect(await emailStatus()).toBe("off");
  });
});
