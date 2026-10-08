import { vi } from "vitest";
import { claims, mem } from "@/test/gbp-sync-store";

/**
 * Shared set-up for the mystery-shop route tests: real tenancy and real
 * transactions on the in-memory Firestore; only the send seam (channel
 * availability + the provider send) and the QStash publish are faked. NO app
 * imports at the top: the mock factories below load this module, and the
 * route is imported lazily.
 *
 *   vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
 *   vi.mock("@/lib/automations/qstash", async () => (await import("@/test/mystery-shop-route-harness")).qstashMock());
 *   vi.mock("@/lib/prospecting/mystery-shop/send", async () => (await import("@/test/mystery-shop-route-harness")).sendMock());
 */

export const publish = vi.fn();
export const send = vi.fn();
export const states = vi.fn();
export const qstashMock = () => ({ publishCallback: (...a: unknown[]) => publish(...a) });
export const sendMock = () => ({
  sendMysteryShop: (...a: unknown[]) => send(...a),
  channelStates: (...a: unknown[]) => states(...a),
});

const d = new Date();
export const MONTH = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
export const USAGE = `subAccounts/sa1/usage/${MONTH}`;
export const EMAIL = "info@acme.co.za";
export const PHONE = "+27821234567";
export const OK = { available: true };
export const NOT_YET = { available: false, reason: "Not available yet." };

const route = () => import("@/app/api/sub-accounts/[id]/prospecting/mystery-shop/route");
const req = (method: string, path: string, body?: unknown, raw?: string) =>
  new Request(`https://app.test/api/sub-accounts/sa1/prospecting/mystery-shop${path}`, {
    method,
    headers: { "x-user-uid": "admin1", "content-type": "application/json" },
    ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = { params: Promise.resolve({ id: "sa1" }) };
export const postRaw = async (raw: string) => (await route()).POST(req("POST", "", undefined, raw), ctx);
export const post = async (body: unknown) => (await route()).POST(req("POST", "", body), ctx);
export const list = async (contactId = "c1") => (await route()).GET(req("GET", `?contactId=${contactId}`), ctx);

/** The enquiry hashes the dialog would echo, read from the real GET. */
export let hashes: { email: string; call: string; whatsapp: string | null } = { email: "", call: "", whatsapp: null };
export async function readHashes(contactId = "c1") {
  hashes = ((await (await list(contactId)).json()) as { enquiryHash: typeof hashes }).enquiryHash;
}
export const valid = (over: Record<string, unknown> = {}) => {
  const channel = (over.channel as string | undefined) ?? "email";
  return {
    contactId: "c1", channel, confirm: true, target: EMAIL,
    enquiryHash: channel === "email" ? hashes.email : channel === "whatsapp" ? hashes.whatsapp : hashes.call,
    ...(channel === "call" ? { consentAck: true } : {}),
    ...over,
  };
};

export const shops = () => mem.list("mysteryShops");
export const used = () => mem.read(USAGE)?.mysteryShops;

export function seedSa(gate = true, extra: Record<string, unknown> = {}) {
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1", name: "Cresta HQ", prospectingEnabledByAgency: gate, defaultPhoneCountry: "ZA", ...extra,
  });
}
export function seedShop(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`mysteryShops/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", target: EMAIL, status: "sent",
    sentAt: new Date(), respondedAt: null, responseMs: null, autoReplyAt: null, jobValueCents: 150_000,
    currency: "ZAR", enquiryText: "x", failure: null, createdAt: new Date(), usageMonth: MONTH,
    ...extra,
  });
}
export function seedContact(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`contacts/${id}`, {
    subAccountId: "sa1", agencyId: "ag1", name: "Acme", company: "Acme Plumbing", email: EMAIL, phone: "082 123 4567",
    city: "Gqeberha", prospecting: { category: "plumber", lastReportId: "r1", website: "https://www.acme.co.za" },
    ...extra,
  });
}

export async function resetRouteHarness() {
  mem.clear();
  claims.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  publish.mockReset().mockResolvedValue({ messageId: "m1" });
  send.mockReset().mockResolvedValue({ ok: true, providerRef: "<abc@crestahq.com>" });
  states.mockReset().mockResolvedValue({ email: OK, call: OK, whatsapp: NOT_YET, form: NOT_YET });
  seedSa();
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  claims.set("admin1", { status: "active", agencyId: "ag1", agencyRole: null });
  seedContact("c1");
  seedContact("c2");
  mem.seed("contacts/cOther", { subAccountId: "sa2", agencyId: "ag1", email: EMAIL, source: "prospecting" });
  await readHashes();
}
