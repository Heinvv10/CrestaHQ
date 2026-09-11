import "server-only";

import type { WhatsappCloudSecret } from "@/types/whatsapp-cloud";
import { describeGraphError } from "../graph-error";
import { parseMessageLink, parsePhoneStatus, parseProfile } from "./parse";
import {
  WaSettingsError,
  type WaBusinessProfileInput,
  type WaPhotoMime,
  type WhatsappSettingsProvider,
} from "./types";

export {
  mapQualityRating,
  parseMessageLink,
  parsePhoneStatus,
  parseProfile,
  validatePrefilledMessage,
  validateProfileInput,
} from "./parse";

/**
 * The real arm of the settings seam: Meta Graph calls on the connected
 * phone number. Every call is addressed to `phoneNumberId` (not the WABA id
 * — the two are adjacent in Meta's dashboard and a transposition 404s).
 * `fetchImpl` is injectable so the unit tests assert the exact requests.
 */

const PHONE_FIELDS = "display_phone_number,verified_name,quality_rating,name_status,status";
const PROFILE_FIELDS = "about,address,description,email,profile_picture_url,websites,vertical";
const LINK_FIELDS = "code,prefilled_message,deep_link_url,qr_image_url";
const TIMEOUT_MS = 15_000;

function base(): string {
  return `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0"}`;
}

export function createGraphSettingsProvider(
  creds: WhatsappCloudSecret,
  fetchImpl: typeof fetch = fetch,
): WhatsappSettingsProvider {
  const { phoneNumberId, accessToken } = creds;

  /**
   * One Graph round-trip. A non-2xx becomes a WaSettingsError carrying Meta's
   * reason (token redacted); a network failure or timeout becomes a 502 with
   * a fixed message, so nothing Meta or the runtime says leaks a token.
   */
  async function call<T>(
    path: string,
    init: RequestInit & { auth?: "Bearer" | "OAuth" } = {},
  ): Promise<T> {
    const { auth = "Bearer", headers, ...rest } = init;
    let res: Response;
    try {
      res = await fetchImpl(`${base()}/${path}`, {
        ...rest,
        headers: { Authorization: `${auth} ${accessToken}`, ...(headers ?? {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new WaSettingsError("Couldn't reach Meta. Try again.", 502);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "unknown error");
      throw new WaSettingsError(describeGraphError(raw, accessToken), res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new WaSettingsError("Meta returned an unreadable response.", 502);
    }
  }

  const json = (body: Record<string, unknown>): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });

  return {
    async getPhoneStatus() {
      return parsePhoneStatus(await call(`${phoneNumberId}?fields=${PHONE_FIELDS}`));
    },

    async getProfile() {
      return parseProfile(
        await call(`${phoneNumberId}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`),
      );
    },

    async updateProfile(input: WaBusinessProfileInput) {
      // The full form every time; an empty string clears a field at Meta.
      await call(`${phoneNumberId}/whatsapp_business_profile`, json({ ...input }));
    },

    // UNTESTED: live — Meta's resumable upload is proven only against a
    // stubbed fetch (running it would change Velocity's real profile picture).
    async uploadProfilePhoto(bytes: Uint8Array, mime: WaPhotoMime) {
      // 1. The app the token belongs to — no env var, so a buyer's own app
      //    works unchanged (probed: works with a system-user token).
      const app = await call<{ id?: string }>("app?fields=id");
      const appId = app.id?.trim();
      if (!appId) throw new WaSettingsError("Meta did not return the app id for this token.", 502);
      // 2. Open an upload session. Token in the header, never the query string.
      const session = await call<{ id?: string }>(
        `${appId}/uploads?file_length=${bytes.byteLength}&file_type=${encodeURIComponent(mime)}`,
        { method: "POST" },
      );
      const uploadId = session.id?.trim();
      if (!uploadId?.startsWith("upload:")) {
        throw new WaSettingsError("Meta did not open an upload session.", 502);
      }
      // 3. The bytes. This endpoint wants `OAuth`, not `Bearer`, and a
      //    file_offset header even for a single chunk.
      const done = await call<{ h?: string }>(uploadId, {
        method: "POST",
        auth: "OAuth",
        headers: { file_offset: "0", "Content-Type": mime },
        // A Blob, not the bare view: TS's BodyInit wants an ArrayBuffer-backed
        // type and fetch sends the bytes verbatim either way.
        body: new Blob([bytes as BlobPart], { type: mime }),
      });
      const handle = done.h?.trim();
      if (!handle) throw new WaSettingsError("Meta accepted the photo but returned no handle.", 502);
      // 4. Point the profile at it.
      await call(
        `${phoneNumberId}/whatsapp_business_profile`,
        json({ profile_picture_handle: handle }),
      );
    },

    async listMessageLinks() {
      const res = await call<{ data?: unknown[] }>(
        `${phoneNumberId}/message_qrdls?fields=${LINK_FIELDS}`,
      );
      return (res.data ?? []).map(parseMessageLink);
    },

    async createMessageLink(prefilledMessage: string) {
      const res = await call(`${phoneNumberId}/message_qrdls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefilled_message: prefilledMessage, generate_qr_image: "SVG" }),
      });
      const link = parseMessageLink(res);
      if (!link.code) {
        throw new WaSettingsError("Meta created the link but returned it without a code.", 502);
      }
      return link;
    },

    async deleteMessageLink(code: string) {
      await call(`${phoneNumberId}/message_qrdls/${encodeURIComponent(code)}`, {
        method: "DELETE",
      });
    },
  };
}
