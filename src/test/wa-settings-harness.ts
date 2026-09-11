import { vi } from "vitest";
import { SUB, resetHarness, state } from "./google-oauth-harness";
import { waFakeScenarioPath } from "@/lib/comms/whatsapp/settings/fake-scenario";
import type { WaFakeScenario } from "@/lib/comms/whatsapp/settings/fake-scenario";

/**
 * Shared setup for the `/api/sub-accounts/[id]/whatsapp/*` route tests. Built
 * on google-oauth-harness's fake Firestore + Auth so the REAL tenancy guard
 * runs against real fake documents (member / admin / collaborator / another
 * sub-account's admin all exist). The fake settings provider is selected by
 * env, fenced to the fixture agency `ag_1`, so its scenario lands at the
 * sub-account's `private/whatsappFakeScenario` in `state.docs`.
 */

export { OTHER_SUB, SUB, state } from "./google-oauth-harness";

export const ORIGINAL_ENV = { ...process.env };

export function resetWaSettings(opts: { gateOn?: boolean; mode?: "fake" | "graph" } = {}) {
  resetHarness();
  state.docs.set(`subAccounts/${SUB}`, {
    agencyId: "ag_1",
    name: "Fixture Workspace",
    whatsappEnabledByAgency: opts.gateOn ?? true,
    whatsappProvider: "cloud",
    whatsappCloudMeta: {
      phoneNumberId: "pn_fixture",
      displayPhoneNumber: "+27 60 000 0000",
      verifiedName: "E2E Fixture Fibre",
      connectedAt: "SERVER_TS",
      connectedByUid: "uid_admin",
    },
  });
  if ((opts.mode ?? "fake") === "fake") {
    process.env.WHATSAPP_SETTINGS_PROVIDER = "fake";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
    process.env.WHATSAPP_FAKE_AGENCY_ID = "ag_1";
  } else {
    delete process.env.WHATSAPP_SETTINGS_PROVIDER;
    delete process.env.WHATSAPP_FAKE_AGENCY_ID;
  }
  delete process.env.WHATSAPP_FAKE_ALLOW_PROD_BUILD;
  (process.env as Record<string, string>).NODE_ENV = "test";
}

export function scenario(sub = SUB): WaFakeScenario | undefined {
  return state.docs.get(waFakeScenarioPath(sub)) as WaFakeScenario | undefined;
}

export function seedScenario(patch: Partial<WaFakeScenario>, sub = SUB) {
  state.docs.set(waFakeScenarioPath(sub), {
    phone: {
      displayPhoneNumber: "+27 60 000 0000",
      verifiedName: "E2E Fixture Fibre",
      qualityRating: "GREEN",
      nameStatus: "APPROVED",
      status: "CONNECTED",
    },
    profile: { about: "", address: "", description: "", email: "", websites: [], vertical: "UNDEFINED", profilePictureUrl: null },
    links: [],
    calls: [],
    ...patch,
  });
}

export type Handler<P> = (r: Request, c: { params: Promise<P> }) => Promise<Response>;

export function call<P extends { id: string }>(
  handler: Handler<P>,
  params: P,
  init: { uid?: string | null; method?: string; body?: unknown; raw?: BodyInit } = {},
) {
  const headers: Record<string, string> = {};
  if (init.uid !== null) headers["x-user-uid"] = init.uid ?? "uid_admin";
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return handler(
    new Request(`http://127.0.0.1:3100/api/sub-accounts/${params.id}/whatsapp`, {
      method: init.method ?? "GET",
      headers,
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    }),
    { params: Promise.resolve(params) },
  );
}

export async function json(pending: Promise<Response>) {
  const res = await pending;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A fetch that records calls and answers each with the next queued body. */
export function stubGraph(bodies: unknown[]) {
  const spy = vi.fn(async () => new Response(JSON.stringify(bodies.shift() ?? {}), { status: 200 }));
  vi.stubGlobal("fetch", spy);
  return spy;
}
