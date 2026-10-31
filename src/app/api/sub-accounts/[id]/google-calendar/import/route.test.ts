import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google Calendar import settings through the REAL routes and tenancy guard
 * over the in-memory Firestore: switching on needs the agency gate, the
 * admin's allowance and the caller's own connection; switching off always
 * works and removes imports at once; nobody can set another member's mode;
 * disconnect removes the caller's imports; GET reports the caller's own
 * import state.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/google-calendar/provider/select", async () => ({
  getGcalProviderFor: async () => (await import("@/test/gcal-import-harness")).provider,
}));

import { claims, mem, storeDb } from "@/test/gbp-sync-store";
import { CONN, SA, U1, U2, conn, connectMember, gev, imported, page, provider, resetImport } from "@/test/gcal-import-harness";
import { flushAfterResponse } from "@/lib/server/after-response";
import { DELETE, GET } from "../route";
import { PATCH } from "./route";

const ADMIN = "admin_1";
const ctx = (id = SA) => ({ params: Promise.resolve({ id }) });
const patch = (uid: string, body: unknown, id = SA) =>
  PATCH(
    new Request(`http://app.local/api/sub-accounts/${id}/google-calendar/import`, {
      method: "PATCH",
      headers: { "x-user-uid": uid, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );
const call = (route: typeof GET, uid: string, method = "GET") =>
  route(new Request(`http://app.local/api/sub-accounts/${SA}/google-calendar`, { method, headers: { "x-user-uid": uid } }), ctx());
const setSub = (over: Record<string, unknown>) => mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`), ...over });

beforeEach(async () => {
  resetImport();
  connectMember(U2);
  mem.seed(`subAccounts/${SA}/subAccountMembers/${ADMIN}`, { uid: ADMIN, status: "active", role: "admin" });
  for (const uid of [U1, U2, ADMIN, "outsider"]) claims.set(uid, { status: "active", agencyId: null, agencyRole: null });
  vi.stubEnv("GOOGLE_CLIENT_ID", "cid");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  provider.syncEvents.mockResolvedValue(page([gev("g1", 2, 3)]));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("guards", () => {
  it("refuses a non-member, an id that is not a document id, and anything but exactly one setting", async () => {
    expect((await patch("outsider", { mode: "busy" })).status).toBe(403);
    // Refused BEFORE any read: "sa_1/subAccountMembers/u1" names a real doc.
    const reads = vi.spyOn(storeDb, "doc");
    expect((await patch(U1, { mode: "busy" }, `${SA}/subAccountMembers/${U1}`)).status).toBe(404);
    expect((await patch(U1, { mode: "busy" }, "__sa__")).status).toBe(404);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect((await patch(U1, {})).status).toBe(400);
    expect((await patch(U1, { mode: "busy", syncNow: true })).status).toBe(400);
    expect((await patch(U1, { mode: "everything" })).status).toBe(400);
    expect((await patch(U1, { allowWorkspace: "yes" })).status).toBe(400);
  });
});

describe("the member's own opt-in", () => {
  beforeEach(() => mem.seed(CONN(U1), { ...conn(U1), importMode: "off" }));

  it("opting in imports the caller's calendar after the response", async () => {
    expect((await patch(U1, { mode: "busy" })).status).toBe(200);
    await flushAfterResponse();
    expect(conn(U1).importMode).toBe("busy");
    expect(imported(U1)).toHaveLength(1);
  });

  it.each([
    ["the agency gate is off", () => setSub({ googleCalendarEnabledByAgency: false }), 403, "gate_off"],
    ["the admin has not allowed it", () => setSub({ calendarImportAllowed: false }), 403, "not_allowed"],
    ["the caller has no connection", () => mem.db.doc(CONN(U1)).delete(), 409, "not_connected"],
    ["the caller's grant is revoked", () => mem.seed(CONN(U1), { ...conn(U1), status: "revoked" }), 409, "not_connected"],
  ])("is refused when %s, and nothing is imported", async (_n, flip, status, code) => {
    await flip();
    const res = await patch(U1, { mode: "details" });
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
    await flushAfterResponse();
    expect(provider.syncEvents).not.toHaveBeenCalled();
    expect(imported()).toEqual([]);
  });

  it("opting out works with the gate off and removes the caller's imports only", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importMode: "busy" });
    const { runCalendarImport } = await import("@/lib/google-calendar/import");
    await runCalendarImport(SA, U1);
    await runCalendarImport(SA, U2);
    setSub({ googleCalendarEnabledByAgency: false });
    const res = await patch(U1, { mode: "off" });
    expect(await res.json()).toEqual({ ok: true, removed: 1 });
    expect(imported(U1)).toEqual([]);
    // U2's opt-in and imports are U2's alone (the gate-off cleanup is another path).
    expect(conn(U2).importMode).toBe("busy");
  });

  it("there is no way to set another member's mode: a named uid is ignored", async () => {
    mem.seed(CONN(U1), { ...conn(U1), importMode: "busy" });
    expect((await patch(U2, { mode: "off", uid: U1 })).status).toBe(200);
    expect(conn(U2).importMode).toBe("off");
    expect(conn(U1).importMode).toBe("busy");
  });

  it("syncNow runs the caller's full pass and answers its result; refused when not opted in", async () => {
    expect((await patch(U1, { syncNow: true })).status).toBe(409);
    mem.seed(CONN(U1), { ...conn(U1), importMode: "busy" });
    const res = await patch(U1, { syncNow: true });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ ok: true, full: true, written: 1 });
    // A second Sync now within a minute of the last full pass: 429, no Google call.
    provider.syncEvents.mockClear();
    const again = await patch(U1, { syncNow: true });
    expect(again.status).toBe(429);
    expect((await again.json()).code).toBe("cooldown");
    expect(provider.syncEvents).not.toHaveBeenCalled();
    setSub({ googleCalendarEnabledByAgency: false });
    expect((await patch(U1, { syncNow: true })).status).toBe(403);
    expect(provider.syncEvents).not.toHaveBeenCalled();
  });
});

describe("the admin's workspace switch", () => {
  it("is admin-only, needs the gate and a configured deployment to switch on", async () => {
    setSub({ calendarImportAllowed: false });
    expect((await patch(U1, { allowWorkspace: true })).status).toBe(403);
    setSub({ googleCalendarEnabledByAgency: false });
    expect((await patch(ADMIN, { allowWorkspace: true })).status).toBe(403);
    setSub({ googleCalendarEnabledByAgency: true });
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    expect((await patch(ADMIN, { allowWorkspace: true })).status).toBe(503);
    expect(mem.read(`subAccounts/${SA}`)?.calendarImportAllowed).toBe(false);
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid");
    expect((await patch(ADMIN, { allowWorkspace: true })).status).toBe(200);
    expect(mem.read(`subAccounts/${SA}`)?.calendarImportAllowed).toBe(true);
  });

  it("an allowance change is audited (actor, before/after); a no-op save is not", async () => {
    const audits = () => mem.list("auditEvents").filter((e) => e.action === "calendar_import.workspace_changed");
    await patch(ADMIN, { allowWorkspace: true });
    expect(audits()).toEqual([]);
    await patch(ADMIN, { allowWorkspace: false });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      actor: { type: "user", id: ADMIN },
      target: { type: "subAccount", id: SA },
      subAccountId: SA,
      changes: [{ field: "calendarImportAllowed", before: true, after: false }],
    });
  });

  it("off works with the gate off, resets every member and removes every import", async () => {
    const { runCalendarImport } = await import("@/lib/google-calendar/import");
    await runCalendarImport(SA, U1);
    await runCalendarImport(SA, U2);
    setSub({ googleCalendarEnabledByAgency: false });
    expect(await (await patch(ADMIN, { allowWorkspace: false })).json()).toEqual({ ok: true, removed: 2 });
    expect(imported()).toEqual([]);
    expect([conn(U1).importMode, conn(U2).importMode]).toEqual(["off", "off"]);
  });
});

describe("status and disconnect", () => {
  it("GET reports the caller's own import state and the workspace allowance", async () => {
    const { runCalendarImport } = await import("@/lib/google-calendar/import");
    await runCalendarImport(SA, U1);
    const body = await (await call(GET, U1)).json();
    expect(body).toMatchObject({ importAllowed: true, importMode: "busy", importStatus: "ok", importedCount: 1 });
    expect(Number.isNaN(Date.parse(body.importLastSyncAt))).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/tok-1|a-u1|r-u1/);
    expect(await (await call(GET, ADMIN)).json()).toMatchObject({ connected: false, importMode: "off", importedCount: 0 });
  });

  it("DELETE still disconnects when the import cleanup fails (logged; the orphan sweep is the backstop)", async () => {
    const real = storeDb.collection;
    const spy = vi.spyOn(storeDb, "collection").mockImplementation(((p: string) => {
      if (p === "events") throw new Error("firestore down");
      return real(p);
    }) as typeof storeDb.collection);
    expect((await call(DELETE, U1, "DELETE")).status).toBe(200);
    spy.mockRestore();
    expect(mem.read(CONN(U1))).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(`[google-calendar] disconnect import cleanup failed sa=${SA}`, "firestore down");
  });

  it("DELETE removes the caller's imports with the connection, and only theirs", async () => {
    const { runCalendarImport } = await import("@/lib/google-calendar/import");
    await runCalendarImport(SA, U1);
    await runCalendarImport(SA, U2);
    expect((await call(DELETE, U1, "DELETE")).status).toBe(200);
    expect(mem.read(CONN(U1))).toBeUndefined();
    expect(imported(U1)).toEqual([]);
    expect(imported(U2)).toHaveLength(1);
  });
});
