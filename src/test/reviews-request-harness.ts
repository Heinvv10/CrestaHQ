import { vi } from "vitest";

/**
 * Shared test harness for `src/lib/reviews/request.ts`.
 *
 * The dispatcher's guard ladder is long enough that its tests live in two
 * files (SMS/config guards vs the WhatsApp compliance guards) to stay under
 * the 300-line file cap. Both need the SAME Firestore + Twilio doubles, so
 * they live here once rather than drifting in two copies.
 *
 * Vitest isolates module state per test file, so each file gets its own fresh
 * copy of the stores and spies below.
 */

// ---- Firestore fake ---------------------------------------------------

/** Documents by full path. A missing path reads as `exists: false`. */
export let docs: Record<string, Record<string, unknown>> = {};
/** Ordered collections by full path (the 24h-window lookback reads one). */
export let collections: Record<string, Array<Record<string, unknown>>> = {};
/** Every write the dispatcher issued, in order. */
export const writes: Array<{ path: string; data: unknown }> = [];
/** Collection/doc paths whose writes throw (fault injection). */
export const failWrites = new Set<string>();

function record(path: string, data: unknown) {
  if (failWrites.has(path)) throw Object.assign(new Error("injected"), { code: 14 });
  writes.push({ path, data });
}

/** Firestore Timestamp stand-in. */
export function ts(ms: number) {
  return { toMillis: () => ms };
}

function makeDoc(path: string) {
  return {
    id: path.split("/").pop() as string,
    get: async () => ({
      exists: Object.prototype.hasOwnProperty.call(docs, path),
      id: path.split("/").pop() as string,
      data: () => docs[path],
    }),
    set: async (data: unknown) => {
      record(path, data);
    },
    collection: (name: string) => makeCollection(`${path}/${name}`),
  };
}

function makeCollection(path: string) {
  const q = {
    orderBy: () => q,
    limit: () => q,
    get: async () => {
      const rows = collections[path] ?? [];
      return { docs: rows.map((r, i) => ({ id: `d${i}`, data: () => r })) };
    },
  };
  return {
    ...q,
    doc: (id: string) => makeDoc(`${path}/${id}`),
    add: async (data: unknown) => {
      record(path, data);
      return { id: "new" };
    },
  };
}

export function fakeDb() {
  return {
    doc: (path: string) => makeDoc(path),
    collection: (path: string) => makeCollection(path),
  };
}

// ---- Twilio + unified inbox -------------------------------------------

export const sendSms = vi.fn(async () => ({
  sid: "SM1",
  from: "+15550001",
  mode: "dedicated",
}));
export const sendWhatsapp = vi.fn(async () => ({
  sid: "WA1",
  from: "+15550002",
}));
export const sendWhatsappTemplate = vi.fn(async () => ({
  sid: "WA2",
  from: "+15550002",
}));
export const smsIsConfigured = vi.fn(() => true);
export const subAccountTwilioIsConfigured = vi.fn(() => true);
export const subAccountWhatsappIsConfigured = vi.fn(() => true);
export const upsertConversation = vi.fn(async () => undefined);

// ---- fixtures ---------------------------------------------------------

export const SA = "sa1";
export const AG = "ag1";
export const C = "c1";
export const SUB_PATH = `subAccounts/${SA}`;
export const CONTACT_PATH = `contacts/${C}`;
export const WA_THREAD_PATH = `contacts/${C}/whatsappMessages`;

export function setSub(over: Record<string, unknown> = {}) {
  docs[SUB_PATH] = {
    name: "Acme Plumbing",
    twilioConfig: { enabled: true },
    googleReviewConfig: {
      enabled: true,
      reviewUrl: "https://g.page/r/acme/review",
      channel: "sms",
      cooldownDays: 90,
      messageTemplate: "",
      triggerOnQuotePaid: true,
      triggerOnDealCompleted: true,
      whatsappTemplateId: null,
    },
    ...over,
  };
}

export function setReviewCfg(over: Record<string, unknown>) {
  const sub = docs[SUB_PATH] as Record<string, unknown>;
  sub.googleReviewConfig = {
    ...(sub.googleReviewConfig as Record<string, unknown>),
    ...over,
  };
}

export function setContact(over: Record<string, unknown> = {}) {
  docs[CONTACT_PATH] = {
    name: "Jane Doe",
    phone: "+61412345678",
    email: "jane@example.com",
    agencyId: AG,
    subAccountId: SA,
    ...over,
  };
}

/** Select an APPROVED single-variable WhatsApp template as the review sender. */
export function setApprovedTemplate(over: Record<string, unknown> = {}) {
  setReviewCfg({ channel: "whatsapp_template", whatsappTemplateId: "t1" });
  docs[`${SUB_PATH}/whatsappTemplates/t1`] = {
    status: "approved",
    contentSid: "HX123",
    body: "Hi {{1}}, mind leaving us a review?",
    variables: [
      { position: 1, source: "merge_tag", mergeTag: "contact.firstName" },
    ],
    ...over,
  };
}

/** Reset every store + spy. Call from the test file's beforeEach. */
export function resetHarness() {
  docs = {};
  collections = {};
  writes.length = 0;
  failWrites.clear();
  vi.clearAllMocks();
  sendSms.mockResolvedValue({
    sid: "SM1",
    from: "+15550001",
    mode: "dedicated",
  });
  sendWhatsapp.mockResolvedValue({ sid: "WA1", from: "+15550002" });
  sendWhatsappTemplate.mockResolvedValue({ sid: "WA2", from: "+15550002" });
  smsIsConfigured.mockReturnValue(true);
  subAccountTwilioIsConfigured.mockReturnValue(true);
  subAccountWhatsappIsConfigured.mockReturnValue(true);
  setSub();
  setContact();
}
