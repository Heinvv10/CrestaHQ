import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());

import { ORIGINAL_ENV, SUB, call, json, resetWaSettings, scenario, seedScenario } from "@/test/wa-settings-harness";
import type { WaMessageLink } from "@/lib/comms/whatsapp/settings/types";
import { DELETE } from "./route";

/** DELETE /whatsapp/message-links/[code] — admin only, code shape-checked. */

const LINK: WaMessageLink = { code: "e2eAbc12345", prefilledMessage: "Hi", deepLinkUrl: "https://wa.me/message/e2eAbc12345", qrImageUrl: null };
const del = (code: string, uid?: string) => call(DELETE, { id: SUB, code }, { uid, method: "DELETE" });

beforeEach(() => {
  resetWaSettings();
  seedScenario({ links: [LINK] });
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

it("an admin deletes a link", async () => {
  const { status, body } = await json(del(LINK.code));
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true });
  expect(scenario()?.links).toEqual([]);
  expect(scenario()?.calls).toEqual([{ op: "deleteMessageLink", arg: LINK.code }]);
});

it("403s a member; the link survives", async () => {
  expect((await del(LINK.code, "uid_member")).status).toBe(403);
  expect(scenario()?.links).toEqual([LINK]);
});

it("400s a code that is not short alphanumeric before it can reach a URL", async () => {
  for (const code of ["", "../../app", "abc/def", "a b", "x".repeat(65), "e2e%2F..", "code?x=1"]) {
    expect((await del(code)).status).toBe(400);
  }
  expect(scenario()?.calls).toEqual([]);
});

it("relays the provider's 404 for an unknown code", async () => {
  const { status } = await json(del("e2eUnknown99"));
  expect(status).toBe(404);
  expect(scenario()?.links).toEqual([LINK]);
});

it("403s when the gate is off", async () => {
  resetWaSettings({ gateOn: false });
  seedScenario({ links: [LINK] });
  expect((await del(LINK.code)).status).toBe(403);
  expect(scenario()?.links).toEqual([LINK]);
});
