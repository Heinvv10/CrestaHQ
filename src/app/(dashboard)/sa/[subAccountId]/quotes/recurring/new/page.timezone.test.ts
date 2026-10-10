// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ScheduleFormValues } from "@/lib/recurring/schedule-form";

/**
 * The schedule's default timezone is the workspace's. On a hard load the
 * workspace doc arrives after the page mounts, so the defaults must follow it
 * rather than freeze at the UTC fallback — until the operator edits them.
 */

const ctx = vi.hoisted(() => ({
  value: {
    subAccountId: "sa1",
    agencyId: "ag1",
    saPath: (p: string) => `/sa/sa1${p}`,
    subAccount: null as Record<string, unknown> | null,
    loading: true,
  },
}));
const fields = vi.hoisted(() => ({
  values: null as ScheduleFormValues | null,
  onChange: null as ((v: ScheduleFormValues) => void) | null,
}));
const auth = vi.hoisted(() => ({ user: { uid: "u1" }, loading: false }));
const contacts = vi.hoisted(() => ({ contacts: [{ id: "c1", name: "Ann" }] }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx.value }));
vi.mock("@/context/contacts-context", () => ({ useSubAccountContacts: () => contacts }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/firestore/products", () => ({ subscribeToProducts: () => () => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/components/quotes/quote-builder", () => ({ QuoteBuilder: () => null }));
vi.mock("@/components/quotes/recurring-schedule-fields", () => ({
  RecurringScheduleFields: (props: { values: ScheduleFormValues; onChange: (v: ScheduleFormValues) => void }) => {
    fields.values = props.values;
    fields.onChange = props.onChange;
    return null;
  },
}));

const { default: NewRecurringInvoicePage } = await import("./page");

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => {
    root.render(createElement(NewRecurringInvoicePage));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fields.values = null;
  fields.onChange = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("takes the workspace timezone when the doc arrives after mount", async () => {
  ctx.value = { ...ctx.value, subAccount: null, loading: true };
  await render();
  // No form to edit before the timezone is known: a first edit stores the
  // whole schedule, UTC fallback included.
  expect(fields.onChange).toBeNull();
  expect(container.querySelector(".animate-spin")).not.toBeNull();
  ctx.value = { ...ctx.value, subAccount: { timezone: "Africa/Johannesburg" }, loading: false };
  await render();
  expect(fields.values?.timezone).toBe("Africa/Johannesburg");
});

it("keeps the operator's edit when the doc changes afterwards", async () => {
  ctx.value = { ...ctx.value, subAccount: { timezone: "Africa/Johannesburg" }, loading: false };
  await render();
  await act(async () => fields.onChange!({ ...fields.values!, timezone: "Europe/London" }));
  ctx.value = { ...ctx.value, subAccount: { timezone: "Asia/Tokyo" }, loading: false };
  await render();
  expect(fields.values?.timezone).toBe("Europe/London");
});
