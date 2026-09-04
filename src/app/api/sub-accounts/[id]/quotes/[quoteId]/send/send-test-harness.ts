import type { NextResponse } from "next/server";
import { vi } from "vitest";

/**
 * Shared fixtures + module mocks for the quote/invoice SEND route tests.
 *
 * The suite is split across three files (auth guards, payment rails, and the
 * send-and-persist path) to stay under the 300-line cap, so the Firestore fake,
 * the spies and the fixture quote live here rather than being copy-pasted three
 * times and drifting apart.
 *
 * Each test file still declares its own `vi.mock(...)` calls — those are
 * hoisted per file by design — but each one is a single line delegating to the
 * matching factory below.
 */

export const QUOTE_ID = "quote123";
export const SUB_ID = "sub123";
export const CONTACT_ID = "contact123";
export const DENIAL_MESSAGE =
  "This record isn't in one of your assigned territories.";

export const CALLER = {
  uid: "uid1",
  email: "operator@example.com",
  subAccountId: SUB_ID,
  subAccountRole: "admin" as const,
};

/** Everything a test can steer, reset between tests by {@link resetHarness}. */
export const state = {
  quoteDoc: null as Record<string, unknown> | null,
  contactDoc: null as Record<string, unknown> | null,
  subDoc: null as Record<string, unknown> | null,
  quoteUpdates: [] as Record<string, unknown>[],
  /** Every path read through the fake, so "touched Firestore not at all" is
   *  assertable rather than inferred from downstream silence. */
  docReads: [] as string[],
  quoteUpdateThrows: null as Error | null,
  accessResult: null as unknown,
  territoryDenies: false,
  emailConfigured: true,
  tokenThrows: null as Error | null,
  publicUrl: null as string | null,
};

// ── Spies ─────────────────────────────────────────────────────────────────
/**
 * Vitest records call arguments BY REFERENCE. The send path mutates the quote
 * (the freshly minted payment link) before handing it to these consumers, so a
 * reference is accurate today — but if a later change mutated that object AFTER
 * the consumers fire, every assertion on it would still pass while pinning
 * nothing. Snapshotting at call time makes the assertion mean what it reads as.
 */
function atCallTime<T>(value: T): T {
  return value !== null && typeof value === "object"
    ? (structuredClone(value) as T)
    : value;
}
export const sendEmail = vi.fn(
  async (_input: Record<string, unknown>) => undefined,
);
export const renderQuoteEmail = vi.fn((_input: Record<string, unknown>) => ({
  subject: "Quote from Acme",
  text: "text-body",
  html: "<p>html-body</p>",
}));
/** Spied so the ARGUMENTS the route hands the territory check are assertable,
 *  not merely that some check ran. Passing the wrong id would otherwise scope a
 *  collaborator against a record that does not exist. */
export const territoryDenialForContact = vi.fn(
  async (_access: unknown, _contactId: string | null | undefined) =>
    state.territoryDenies ? { status: 403, error: DENIAL_MESSAGE } : null,
);
export const recordQuoteActivity = vi.fn(async () => undefined);
export const fireQuoteTrigger = vi.fn(async () => undefined);
export const emitQuoteWebhook = vi.fn(async () => undefined);

// ── Fake Firestore ────────────────────────────────────────────────────────
function snapshotFor(path: string) {
  state.docReads.push(path);
  const doc = path.startsWith("quotes/")
    ? state.quoteDoc
    : path.startsWith("contacts/")
      ? state.contactDoc
      : path.startsWith("subAccounts/")
        ? state.subDoc
        : null;
  return {
    id: path.split("/").pop() ?? "",
    exists: doc !== null,
    data: () => doc ?? undefined,
  };
}

function docRef(path: string) {
  return {
    path,
    get: async () => snapshotFor(path),
    update: async (data: Record<string, unknown>) => {
      if (state.quoteUpdateThrows) throw state.quoteUpdateThrows;
      state.quoteUpdates.push(data);
    },
  };
}

export const fakeDb = {
  collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
  doc: (path: string) => docRef(path),
};

// ── Mock factories ────────────────────────────────────────────────────────
/** `FieldValue.serverTimestamp()` becomes an assertable sentinel. */
export const firestoreMock = () => ({
  FieldValue: { serverTimestamp: () => "__SERVER_TS__" },
});

export const adminMock = () => ({ getAdminDb: () => fakeDb });

export const tenancyMock = () => ({
  requireSubAccountMember: async () => state.accessResult,
});

/**
 * Only the denial form is mocked. The route consumes that; the service imports
 * `TerritoryDenial` as a type, which is erased. `territoryGateForContact` is
 * deliberately absent — mocking an export nothing under test imports would be
 * dead weight that outlives the thing it was written for.
 */
export const territoryMock = () => ({
  territoryDenialForContact: (access: unknown, contactId?: string | null) =>
    territoryDenialForContact(access, contactId),
});

export const resendMock = () => ({
  emailIsConfigured: () => state.emailConfigured,
  sendEmail: (input: Record<string, unknown>) => sendEmail(input),
  tenantFrom: (sub: unknown) =>
    (sub as { name?: string } | null)?.name
      ? `tenant-from:${(sub as { name?: string }).name}`
      : "tenant-from:none",
});

export const tokenMock = () => ({
  issueQuoteToken: () => {
    if (state.tokenThrows) throw state.tokenThrows;
    return { token: "tok_abc", hash: "hash_abc" };
  },
  buildQuoteUrl: () => state.publicUrl,
});

export const emailMock = () => ({
  renderQuoteEmail: (input: Record<string, unknown>) =>
    renderQuoteEmail(atCallTime(input)),
});

export const lifecycleMock = () => ({
  recordQuoteActivity: (...a: unknown[]) =>
    recordQuoteActivity(...(a.map(atCallTime) as [])),
  fireQuoteTrigger: (...a: unknown[]) =>
    fireQuoteTrigger(...(a.map(atCallTime) as [])),
  emitQuoteWebhook: (...a: unknown[]) =>
    emitQuoteWebhook(...(a.map(atCallTime) as [])),
});

// ── Fixtures + invocation ─────────────────────────────────────────────────
export function baseQuote(overrides: Record<string, unknown> = {}) {
  return {
    agencyId: "agency1",
    subAccountId: SUB_ID,
    createdByUid: "uid1",
    contactId: CONTACT_ID,
    quoteNumber: "Q-2026-0001",
    kind: "quote",
    status: "draft",
    currency: "USD",
    lineItems: [{ id: "l1", description: "Work", quantity: 2, unitPrice: 50 }],
    globalDiscount: null,
    globalTaxPercent: null,
    termsAndNotes: "",
    billedToOrganization: null,
    billingAddress: null,
    validUntil: null,
    paymentDueDays: null,
    ...overrides,
  };
}

type RoutePost = (
  request: Request,
  ctx: { params: Promise<{ id: string; quoteId: string }> },
) => Promise<NextResponse>;

/** Invoke the route and unwrap its JSON body + status. */
export async function callJson(
  POST: RoutePost,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new Request(
      "http://localhost/api/sub-accounts/sub123/quotes/quote123/send",
      { method: "POST" },
    ),
    { params: Promise.resolve({ id: SUB_ID, quoteId: QUOTE_ID }) },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** Restore every steerable value to the happy path. Call from `beforeEach`. */
export function resetHarness(): void {
  vi.clearAllMocks();
  state.quoteDoc = baseQuote();
  state.contactDoc = { email: "recipient@example.com", name: "Jane Doe" };
  state.subDoc = {
    name: "Acme Plumbing",
    logoUrl: "https://cdn.example.com/logo.png",
  };
  state.quoteUpdates = [];
  state.docReads = [];
  state.quoteUpdateThrows = null;
  state.accessResult = CALLER;
  state.territoryDenies = false;
  state.emailConfigured = true;
  state.tokenThrows = null;
  state.publicUrl = "https://app.example.com/q/tok_abc";
  sendEmail.mockResolvedValue(undefined);
  // clearAllMocks() wipes the recorded implementation too, so restore it.
  territoryDenialForContact.mockImplementation(async () =>
    state.territoryDenies ? { status: 403, error: DENIAL_MESSAGE } : null,
  );
  // Silence the deliberate console.error paths.
  vi.spyOn(console, "error").mockImplementation(() => {});
}
