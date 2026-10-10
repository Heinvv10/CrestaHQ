import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { PAGE, pageForm } from "@/test/booking-fixtures";

/**
 * A booking page's style preset through the agent's booking-page tools (the
 * real dispatch and decide route). update_booking_page is a full-replace
 * save, so the stored preset must ride along on every edit; an unknown
 * preset is refused by the routes' own validator.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");

const P = "subAccounts/sa1/bookingPages";
const call = (name: string, args: Record<string, unknown>) => dispatchAgentTool(auth, name, args);
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
/** A page stored before presets existed: the field is absent, not null. */
const { themePreset: _never, ...LEGACY } = PAGE;

beforeEach(() => {
  mem.seed(`${P}/styled`, { ...PAGE, id: "styled", slug: "styled", name: "Styled", themePreset: "ocean" });
  mem.seed(`${P}/legacy`, { ...LEGACY, id: "legacy", slug: "legacy", name: "Legacy" });
  mem.seed(`${P}/live`, { ...PAGE, id: "live", slug: "live", name: "Live", status: "published", themePreset: "ocean" });
});

describe("the style preset through the booking-page tools", () => {
  it("an edit of another field keeps the stored preset", async () => {
    expect(await call("update_booking_page", { slug: "styled", durationMinutes: 45 })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/styled`)).toMatchObject({ durationMinutes: 45, themePreset: "ocean" });
  });

  it("sets, changes and clears the preset", async () => {
    expect(await call("update_booking_page", { slug: "legacy", themePreset: "noir-lime" })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/legacy`)!.themePreset).toBe("noir-lime");
    expect(await call("update_booking_page", { slug: "legacy", themePreset: "sunset" })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/legacy`)!.themePreset).toBe("sunset");
    expect(await call("update_booking_page", { slug: "legacy", themePreset: null })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/legacy`)!.themePreset).toBeNull();
  });

  it("an edit of a page stored before presets leaves it without one", async () => {
    expect(await call("update_booking_page", { slug: "legacy", durationMinutes: 45 })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/legacy`)!.themePreset ?? null).toBeNull();
  });

  it("refuses an unknown preset and writes nothing", async () => {
    expect(await call("update_booking_page", { slug: "styled", themePreset: "bogus" })).toMatchObject({ ok: false, message: "Unknown style preset." });
    expect(mem.read(`${P}/styled`)!.themePreset).toBe("ocean");
    expect(await call("create_booking_page", pageForm("intro", { name: "Intro call", themePreset: "bogus" }))).toMatchObject({ ok: false, message: "Unknown style preset." });
    expect(mem.read(`${P}/intro`)).toBeUndefined();
  });

  it("creates a page with a preset, and get_booking_page shows it", async () => {
    expect(await call("create_booking_page", { slug: "intro", name: "Intro call", themePreset: "midnight" })).toMatchObject({ ok: true });
    expect(mem.read(`${P}/intro`)!.themePreset).toBe("midnight");
    const read = await call("get_booking_page", { slug: "intro" });
    expect(read).toMatchObject({ ok: true });
    expect(JSON.stringify(read)).toContain("themePreset: midnight");
  });

  it("on a published page the change is shown old -> new for approval, then applied", async () => {
    const r = await call("update_booking_page", { slug: "live", themePreset: "noir-lime" });
    if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
    expect(row(r.proposal.id).approval).toBe("public_change");
    expect(rowOf(r.proposal.id, "themePreset")).toBe("ocean → noir-lime");
    expect(mem.read(`${P}/live`)!.themePreset).toBe("ocean");
    expect((await decide(r.proposal.id, "approve")).status).toBe(200);
    expect(mem.read(`${P}/live`)!.themePreset).toBe("noir-lime");
  });
});
