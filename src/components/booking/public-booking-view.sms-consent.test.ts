// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicBookingView } from "./public-booking-view";
import { seedPage } from "@/test/booking-harness";
import { publicBookingPage } from "@/lib/booking/public-page";

/**
 * The consent line under the phone field. A page that texts its bookers says
 * so where the number is typed; the public payload carries only the boolean
 * `textsBooker` (never the reminder settings behind it).
 */

const LINE = "We'll text booking confirmations and reminders to this number.";
const SLOT = { startAt: "2026-09-14T09:00:00.000Z", endAt: "2026-09-14T09:30:00.000Z" };

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

async function openForm(over: Record<string, unknown>) {
  fetchMock.mockImplementation(async () => Response.json({ slots: [SLOT] }));
  const page = publicBookingPage(seedPage("p", over as never), "p");
  await act(async () =>
    root.render(createElement(PublicBookingView, { subAccountId: "sa1", page, branding: { name: "Fixture", logoUrl: null, accentColor: null } })),
  );
  await act(async () => [...container.querySelectorAll("button")].find((b) => /^\d{1,2}:\d{2}/.test(b.textContent ?? ""))!.click());
}
/** The text under the phone input, inside its own field. */
const phoneFieldText = () => container.querySelector("#b-phone")!.parentElement!.textContent ?? "";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("publicBookingPage textsBooker", () => {
  it("is true only for a page with texts on", () => {
    expect(publicBookingPage(seedPage("a", { smsRemindersEnabled: true } as never), "a").textsBooker).toBe(true);
    expect(publicBookingPage(seedPage("b", { smsRemindersEnabled: false } as never), "b").textsBooker).toBe(false);
    expect(publicBookingPage(seedPage("c"), "c").textsBooker).toBe(false);
    expect(publicBookingPage(seedPage("d", { smsRemindersEnabled: "yes" } as never), "d").textsBooker).toBe(false);
  });

  it("exposes the flag as a plain boolean and nothing else of the reminder settings", () => {
    const page = publicBookingPage(seedPage("a", { smsRemindersEnabled: true, remindersEnabled: true, reminderOffsetsMinutes: [1439] } as never), "a");
    expect(Object.keys(page).filter((k) => /remind|sms/i.test(k))).toEqual([]);
    expect(JSON.stringify(page)).not.toContain("1439");
    expect(JSON.stringify(page)).not.toContain("smsRemindersEnabled");
  });
});

describe("the booking form", () => {
  it("says it will text the number when the page texts its bookers", async () => {
    await openForm({ smsRemindersEnabled: true });
    expect(phoneFieldText()).toContain(LINE);
  });

  it.each([
    ["off", { smsRemindersEnabled: false }],
    ["never set", {}],
  ])("says nothing when texts are %s", async (_label, over) => {
    await openForm(over);
    expect(container.textContent).not.toContain("text booking confirmations");
  });
});
