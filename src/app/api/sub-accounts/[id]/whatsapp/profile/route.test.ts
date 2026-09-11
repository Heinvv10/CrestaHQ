import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());

import { ORIGINAL_ENV, SUB, call, json, resetWaSettings, scenario, seedScenario } from "@/test/wa-settings-harness";
import { GET, PUT } from "./route";

/** /whatsapp/profile — read for members, write for admins, validated. */

const FORM = { about: "Fibre", address: "1 Road", description: "", email: "hi@example.com", websites: ["https://a.example"], vertical: "RETAIL" };

beforeEach(() => resetWaSettings());
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET", () => {
  it("any member reads the profile as the provider holds it", async () => {
    seedScenario({ profile: { ...FORM, profilePictureUrl: null } });
    const { status, body } = await json(call(GET, { id: SUB }, { uid: "uid_collab" }));
    expect(status).toBe(200);
    expect(body).toEqual({ ...FORM, profilePictureUrl: null });
  });

  it("403s a non-member and a gated-off workspace", async () => {
    expect((await call(GET, { id: SUB }, { uid: "uid_other_admin" })).status).toBe(403);
    resetWaSettings({ gateOn: false });
    expect((await call(GET, { id: SUB })).status).toBe(403);
  });
});

describe("PUT", () => {
  it("an admin saves the full form and gets back the re-read profile", async () => {
    const { status, body } = await json(call(PUT, { id: SUB }, { method: "PUT", body: FORM }));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, profile: { ...FORM, profilePictureUrl: null } });
    expect(scenario()?.profile).toEqual({ ...FORM, profilePictureUrl: null });
    expect(scenario()?.calls).toEqual([{ op: "updateProfile" }]);
  });

  it("a plain member and a collaborator may NOT write, and nothing reaches the provider", async () => {
    for (const uid of ["uid_member", "uid_collab", "uid_other_admin"]) {
      const { status } = await json(call(PUT, { id: SUB }, { uid, method: "PUT", body: FORM }));
      expect(status).toBe(403);
    }
    expect(scenario()).toBeUndefined();
  });

  it("400s Meta's limits before the provider is touched", async () => {
    for (const bad of [
      { ...FORM, about: "x".repeat(140) },
      { ...FORM, websites: ["https://a.x", "https://b.x", "https://c.x"] },
      { ...FORM, websites: ["ftp://a.x"] },
      { ...FORM, vertical: "PLUMBING" },
    ]) {
      const { status } = await json(call(PUT, { id: SUB }, { method: "PUT", body: bad }));
      expect(status).toBe(400);
    }
    expect((await call(PUT, { id: SUB }, { method: "PUT", raw: "{not json" })).status).toBe(400);
    expect(scenario()).toBeUndefined();
  });

  it("403s when the gate is off, even for an admin", async () => {
    resetWaSettings({ gateOn: false });
    expect((await call(PUT, { id: SUB }, { method: "PUT", body: FORM })).status).toBe(403);
    expect(scenario()).toBeUndefined();
  });

  it("relays a scripted provider failure as its status and message", async () => {
    seedScenario({ failNext: { op: "updateProfile", status: 400, message: "About is too long." } });
    const { status, body } = await json(call(PUT, { id: SUB }, { method: "PUT", body: FORM }));
    expect(status).toBe(400);
    expect(body).toEqual({ error: "About is too long." });
    // A failed call is still a call, and the profile did not change.
    expect(scenario()?.calls).toEqual([{ op: "updateProfile" }]);
    expect(scenario()?.profile.about).toBe("");
  });

  it("clamps a provider status outside 400–502", async () => {
    seedScenario({ failNext: { op: "updateProfile", status: 503, message: "Service temporarily unavailable" } });
    expect((await call(PUT, { id: SUB }, { method: "PUT", body: FORM })).status).toBe(502);
    seedScenario({ failNext: { op: "updateProfile", status: 200, message: "odd" } });
    expect((await call(PUT, { id: SUB }, { method: "PUT", body: FORM })).status).toBe(400);
  });
});
