import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());

import { ORIGINAL_ENV, SUB, call, json, resetWaSettings, scenario, seedScenario } from "@/test/wa-settings-harness";
import type { WaMessageLink } from "@/lib/comms/whatsapp/settings/types";
import { GET, POST } from "./route";

/** /whatsapp/message-links — list for members, create for admins. */

const EXISTING: WaMessageLink = { code: "e2eAbc12345", prefilledMessage: "Hi", deepLinkUrl: "https://wa.me/message/e2eAbc12345", qrImageUrl: null };

beforeEach(() => resetWaSettings());
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET", () => {
  it("any member lists the links", async () => {
    seedScenario({ links: [EXISTING] });
    const { status, body } = await json(call(GET, { id: SUB }, { uid: "uid_member" }));
    expect(status).toBe(200);
    expect(body).toEqual({ links: [EXISTING] });
  });

  it("403s a non-member and a gated-off workspace", async () => {
    expect((await call(GET, { id: SUB }, { uid: "uid_other_admin" })).status).toBe(403);
    resetWaSettings({ gateOn: false });
    expect((await call(GET, { id: SUB })).status).toBe(403);
  });
});

describe("POST", () => {
  it("an admin creates a link: 201 with a code, a wa.me deep link and an inline QR", async () => {
    const { status, body } = await json(call(POST, { id: SUB }, { method: "POST", body: { prefilledMessage: "  Hello from the fixture " } }));
    expect(status).toBe(201);
    const link = body.link as WaMessageLink;
    expect(link.code).toMatch(/^e2e[A-Za-z0-9]{8}$/);
    expect(link.prefilledMessage).toBe("Hello from the fixture");
    expect(link.deepLinkUrl).toBe(`https://wa.me/message/${link.code}`);
    expect(link.qrImageUrl).toMatch(/^data:image\/svg\+xml/);
    expect(scenario()?.links).toEqual([link]);
    expect(scenario()?.calls).toEqual([{ op: "createMessageLink", arg: "Hello from the fixture" }]);
  });

  it("403s a member and a collaborator; nothing reaches the provider", async () => {
    for (const uid of ["uid_member", "uid_collab"]) {
      expect((await call(POST, { id: SUB }, { uid, method: "POST", body: { prefilledMessage: "Hi" } })).status).toBe(403);
    }
    expect(scenario()).toBeUndefined();
  });

  it("400s an empty message, one over 140 chars, a non-string, and bad JSON", async () => {
    for (const body of [{ prefilledMessage: "" }, { prefilledMessage: "   " }, { prefilledMessage: "x".repeat(141) }, { prefilledMessage: 5 }, {}]) {
      expect((await call(POST, { id: SUB }, { method: "POST", body })).status).toBe(400);
    }
    expect((await call(POST, { id: SUB }, { method: "POST", raw: "nope" })).status).toBe(400);
    expect((await call(POST, { id: SUB }, { method: "POST", body: { prefilledMessage: "x".repeat(140) } })).status).toBe(201);
  });

  it("relays a scripted provider failure", async () => {
    seedScenario({ failNext: { op: "createMessageLink", status: 429, message: "Too many message links." } });
    const { status, body } = await json(call(POST, { id: SUB }, { method: "POST", body: { prefilledMessage: "Hi" } }));
    expect(status).toBe(429);
    expect(body).toEqual({ error: "Too many message links." });
    expect(scenario()?.links).toEqual([]);
  });
});
