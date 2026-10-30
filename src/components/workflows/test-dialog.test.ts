// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";

/**
 * The Test workflow dialog used to run its own `where(subAccountId).limit(100)`
 * Firestore query, so a sub-account with 8,000+ contacts could only ever
 * search the first 100 — a real customer's name or phone returned "No
 * contacts found". The fix drops that query for the shared
 * `useSubAccountContacts` context (subscribed to the full list). These
 * tests render TestDialog against a mocked context so they exercise the
 * component's actual data source, not a copy of the filter logic sitting
 * beside it — proving the dialog no longer depends on a 100-contact cap.
 */
const ctxState = vi.hoisted(() => ({
  contacts: [] as Contact[],
  loading: false,
  error: null as Error | null,
  requestedEnabled: [] as boolean[],
}));

vi.mock("@/context/contacts-context", () => ({
  useSubAccountContacts: (enabled: boolean) => {
    ctxState.requestedEnabled.push(enabled);
    return {
      contacts: ctxState.contacts,
      loading: ctxState.loading,
      error: ctxState.error,
    };
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TestDialog, filterTestContacts } from "./test-dialog";

function makeContact(overrides: Partial<Contact>): Contact {
  return {
    id: "id",
    name: "",
    email: "",
    phone: "",
    company: "",
    address: "",
    source: "",
    tags: [],
    pipelineStage: null,
    attribution: null,
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u1",
    emailOptedOut: false,
    smsOptedOut: false,
    countryCode: null,
    country: null,
    city: null,
    lat: null,
    lng: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as Contact;
}

let container: HTMLDivElement;
let root: Root;
const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  ctxState.contacts = [];
  ctxState.loading = false;
  ctxState.error = null;
  ctxState.requestedEnabled = [];
  global.fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  global.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(contacts: Contact[]) {
  ctxState.contacts = contacts;
  await act(async () => {
    root.render(
      createElement(TestDialog, {
        saId: "sa1",
        workflowId: "wf1",
        open: true,
        onOpenChange: () => {},
      }),
    );
  });
}

function typeQuery(term: string) {
  const input = document.body.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, term);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function resultNames(): string[] {
  return Array.from(document.body.querySelectorAll("button span.font-medium")).map(
    (el) => el.textContent ?? "",
  );
}

it("subscribes to the shared contacts context instead of its own query, only while open", async () => {
  await render([makeContact({ id: "c1", name: "Only Contact" })]);
  expect(ctxState.requestedEnabled).toContain(true);
});

it("finds a contact beyond the old 100-contact page by name", async () => {
  const contacts = Array.from({ length: 150 }, (_, i) =>
    makeContact({ id: `c${i}`, name: `Contact ${i}` }),
  );
  contacts[149] = makeContact({ id: "target", name: "Zanele Beyond Limit" });
  await render(contacts);
  typeQuery("Zanele");
  expect(resultNames()).toEqual(["Zanele Beyond Limit"]);
});

it.each(["0823216574", "823216574", "+27 82 321 6574"])(
  "matches phone format %s against a contact stored as +27823216574",
  async (typed) => {
    const contacts = Array.from({ length: 150 }, (_, i) =>
      makeContact({ id: `c${i}`, name: `Contact ${i}` }),
    );
    contacts[149] = makeContact({
      id: "target",
      name: "Beyond Limit Phone",
      phone: "+27823216574",
    });
    await render(contacts);
    typeQuery(typed);
    expect(resultNames()).toEqual(["Beyond Limit Phone"]);
  },
);

it("caps rendered results but hints at more", async () => {
  const contacts = Array.from({ length: 60 }, (_, i) =>
    makeContact({ id: `c${i}`, name: `Match ${i}` }),
  );
  await render(contacts);
  typeQuery("Match");
  expect(resultNames().length).toBe(50);
  expect(document.body.textContent).toContain("10 more match");
});

it("POSTs the enrolled contact id and closes on success", async () => {
  await render([makeContact({ id: "target", name: "Pick Me" })]);
  const button = document.body.querySelector("button") as HTMLButtonElement;
  await act(async () => {
    button.click();
  });
  expect(global.fetch).toHaveBeenCalledWith(
    "/api/sub-accounts/sa1/workflows/wf1/test",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ contactId: "target" }),
    }),
  );
});

it("filterTestContacts: empty query returns everything, unmatched term returns nothing", () => {
  const contacts = [makeContact({ id: "c1", name: "Someone" })];
  expect(filterTestContacts(contacts, "")).toEqual(contacts);
  expect(filterTestContacts(contacts, "nope")).toEqual([]);
});
