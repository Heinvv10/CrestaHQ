// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 d2 — the review-request reminder setting, rendered for real (jsdom).
 * Off unless an admin turns it on; saved with PATCH on the google-review
 * route; says when reminders stop, and that a template's link can't be tracked.
 */

const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true, subAccount: null as Record<string, unknown> | null }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

import { ReviewReminderCard } from "./review-reminder-card";

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;
const cfg = (over: Record<string, unknown> = {}) => ({
  googleReviewConfig: { reviewUrl: "https://g.page/r/x/review", channel: "sms", ...over },
});

beforeEach(() => {
  Object.assign(ctx, { isAdmin: true, subAccount: cfg() });
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(createElement(ReviewReminderCard)));
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function pick(id: string, value: string) {
  await act(async () => {
    const el = byId(id) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const save = () => act(async () => (byId("rep-reminder-save") as HTMLButtonElement).click());

describe("reminder card", () => {
  it("is off by default, with retries disabled, and says when reminders stop", async () => {
    await render();
    expect((byId("rep-reminder-every") as HTMLSelectElement).value).toBe("off");
    expect((byId("rep-reminder-retries") as HTMLSelectElement).disabled).toBe(true);
    expect(byId("rep-reminder-card")?.textContent).toContain(
      "Reminders stop when the customer clicks the link, opts out, or the retries run out",
    );
  });

  it("shows a stored setting", async () => {
    ctx.subAccount = cfg({ reminder: { everyDays: 7, maxRetries: 3 } });
    await render();
    expect((byId("rep-reminder-every") as HTMLSelectElement).value).toBe("7");
    expect((byId("rep-reminder-retries") as HTMLSelectElement).value).toBe("3");
    // A setting outside today's range reads as off rather than a value the form can't show.
    ctx.subAccount = cfg({ reminder: { everyDays: 14, maxRetries: 3 } });
    await render();
    expect((byId("rep-reminder-every") as HTMLSelectElement).value).toBe("off");
  });

  it("saves with PATCH and says so", async () => {
    await render();
    await pick("rep-reminder-every", "3");
    await pick("rep-reminder-retries", "2");
    await save();
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/google-review", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ reminder: { everyDays: 3, maxRetries: 2 } }),
    }));
    expect(byId("rep-reminder-result")?.getAttribute("data-state")).toBe("saved");
  });

  it("turning it off saves everyDays null", async () => {
    ctx.subAccount = cfg({ reminder: { everyDays: 7, maxRetries: 3 } });
    await render();
    await pick("rep-reminder-every", "off");
    await save();
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ reminder: { everyDays: null, maxRetries: 3 } }));
  });

  it("shows the route's refusal inline", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "Save your review link first." }) });
    await render();
    await pick("rep-reminder-every", "3");
    await save();
    expect(byId("rep-reminder-result")?.getAttribute("data-state")).toBe("error");
    expect(byId("rep-reminder-result")?.textContent).toBe("Save your review link first.");
  });

  it("with no review link saved there is nothing to set yet", async () => {
    ctx.subAccount = { googleReviewConfig: null };
    await render();
    expect(byId("rep-reminder-no-link")).not.toBeNull();
    expect(byId("rep-reminder-save")).toBeNull();
  });

  it("SMS only: on a WhatsApp channel it says why and can't be turned on", async () => {
    for (const channel of ["whatsapp_template", "whatsapp_manual"]) {
      ctx.subAccount = cfg({ channel });
      await render();
      expect(byId("rep-reminder-sms-only")?.textContent).toContain("SMS only");
      expect((byId("rep-reminder-every") as HTMLSelectElement).disabled).toBe(true);
    }
    ctx.subAccount = cfg({ channel: "sms" });
    await render();
    expect(byId("rep-reminder-sms-only")).toBeNull();
    expect((byId("rep-reminder-every") as HTMLSelectElement).disabled).toBe(false);
  });

  it("names the senders reminders go with, and offers at most 7 days", async () => {
    await render();
    expect(byId("rep-reminder-card")?.textContent).toContain(
      "Reminders go with review requests sent by Request review, Send Review Request, quote paid and deal completed — not workflows, broadcasts or inbox messages.",
    );
    const days = [...(byId("rep-reminder-every") as HTMLSelectElement).options].map((o) => o.value);
    expect(days).toEqual(["off", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it("renders nothing for a member who is not an admin", async () => {
    ctx.isAdmin = false;
    await render();
    expect(byId("rep-reminder-card")).toBeNull();
  });
});
