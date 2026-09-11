import "server-only";

import { randomBytes } from "node:crypto";
import {
  defaultWaFakeScenario,
  type WaFakeScenario,
  type WaFakeScenarioStore,
} from "./fake-scenario";
import {
  WaSettingsError,
  type WaBusinessProfileInput,
  type WaMessageLink,
  type WaPhotoMime,
  type WhatsappSettingsProvider,
} from "./types";

/**
 * Deterministic stand-in for Meta, driven by a {@link WaFakeScenarioStore}.
 * Reachable only through `getWhatsappSettingsProviderFor` in select.ts, which
 * refuses it outside loopback dev/CI and outside the fixture agency. Each
 * instance is BOUND to one sub-account: the store is only ever read or
 * written for that id.
 *
 * Everything it hands back renders without an external host — the QR is an
 * inline SVG data URL and an uploaded photo becomes a data URL — so the E2E
 * page proof needs nothing but the app.
 */

type Op = keyof WhatsappSettingsProvider;
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Photos larger than this are stored as a placeholder rather than inlined. */
const INLINE_PHOTO_MAX = 20 * 1024;
const PLACEHOLDER_PHOTO =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='%23ccc'/><text x='10' y='60' font-size='12'>FAKE PHOTO</text></svg>";

function mintCode(): string {
  const bytes = randomBytes(8);
  let out = "e2e";
  for (const b of bytes) out += ALNUM[b % ALNUM.length];
  return out;
}

function qrFor(code: string): string {
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='%23fff'/><text x='10' y='60' font-size='12'>FAKE QR ${code}</text></svg>`;
}

export function createFakeWhatsappSettingsProvider(
  store: WaFakeScenarioStore,
  bound: string,
): WhatsappSettingsProvider {
  async function load(): Promise<WaFakeScenario> {
    return (await store.get(bound)) ?? defaultWaFakeScenario();
  }

  /** Throw the scripted failure for `op` once, persisting that it was used. */
  async function consume(scenario: WaFakeScenario, op: Op) {
    if (scenario.failNext?.op !== op) return;
    const { status, message } = scenario.failNext;
    delete scenario.failNext;
    await store.set(bound, scenario);
    throw new WaSettingsError(message, status);
  }

  /** Log a mutating call BEFORE anything can fail — a failed call is still a call. */
  async function mutating(op: Op, arg?: string): Promise<WaFakeScenario> {
    const scenario = await load();
    scenario.calls = [...(scenario.calls ?? []), arg === undefined ? { op } : { op, arg }];
    await store.set(bound, scenario);
    await consume(scenario, op);
    return scenario;
  }

  async function reading(op: Op): Promise<WaFakeScenario> {
    const scenario = await load();
    await consume(scenario, op);
    return scenario;
  }

  return {
    async getPhoneStatus() {
      return (await reading("getPhoneStatus")).phone;
    },

    async getProfile() {
      return (await reading("getProfile")).profile;
    },

    async updateProfile(input: WaBusinessProfileInput) {
      const scenario = await mutating("updateProfile");
      scenario.profile = { ...input, profilePictureUrl: scenario.profile.profilePictureUrl };
      await store.set(bound, scenario);
    },

    async uploadProfilePhoto(bytes: Uint8Array, mime: WaPhotoMime) {
      const scenario = await mutating("uploadProfilePhoto", `${mime}:${bytes.byteLength}`);
      scenario.profile.profilePictureUrl =
        bytes.byteLength <= INLINE_PHOTO_MAX
          ? `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
          : PLACEHOLDER_PHOTO;
      await store.set(bound, scenario);
    },

    async listMessageLinks() {
      return (await reading("listMessageLinks")).links;
    },

    async createMessageLink(prefilledMessage: string) {
      const scenario = await mutating("createMessageLink", prefilledMessage);
      const code = mintCode();
      const link: WaMessageLink = {
        code,
        prefilledMessage,
        deepLinkUrl: `https://wa.me/message/${code}`,
        qrImageUrl: qrFor(code),
      };
      scenario.links = [...scenario.links, link];
      await store.set(bound, scenario);
      return link;
    },

    async deleteMessageLink(code: string) {
      const scenario = await mutating("deleteMessageLink", code);
      if (!scenario.links.some((l) => l.code === code)) {
        throw new WaSettingsError("Unsupported post request. Object does not exist.", 404);
      }
      scenario.links = scenario.links.filter((l) => l.code !== code);
      await store.set(bound, scenario);
    },
  };
}
