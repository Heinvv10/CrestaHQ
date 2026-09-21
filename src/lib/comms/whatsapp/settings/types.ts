import type { WaQualityRating } from "@/types/whatsapp-cloud";

export type { WaQualityRating } from "@/types/whatsapp-cloud";

/**
 * The WhatsApp settings provider seam (SP15): the three Meta Graph resources
 * behind the Settings → WhatsApp page — the phone-number node (header badge),
 * `whatsapp_business_profile` (Profile tab) and `message_qrdls` (Message
 * Links tab). Two arms: `graph.ts` (real Meta) and `fake.ts` (dev/CI only,
 * fenced by mode.ts + select.ts exactly like the GBP fake). Obtain one ONLY
 * through `getWhatsappSettingsProviderFor` in select.ts.
 *
 * No outbound message goes through this seam; the only Meta writes are the
 * profile POST, the photo upload and message-link create/delete.
 */

export interface WaPhoneStatus {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: WaQualityRating;
  /** APPROVED | AVAILABLE_WITHOUT_REVIEW | DECLINED | EXPIRED | PENDING_REVIEW | NONE */
  nameStatus: string | null;
  /** e.g. CONNECTED */
  status: string | null;
}

export interface WaBusinessProfile {
  about: string;
  address: string;
  description: string;
  email: string;
  websites: string[];
  vertical: string;
  profilePictureUrl: string | null;
}

export type WaBusinessProfileInput = Omit<WaBusinessProfile, "profilePictureUrl">;

export interface WaMessageLink {
  code: string;
  prefilledMessage: string;
  deepLinkUrl: string;
  qrImageUrl: string | null;
}

export type WaPhotoMime = "image/jpeg" | "image/png";

/** A provider failure with the HTTP status the route should relay (400–502). */
export class WaSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WaSettingsError";
  }
}

export interface WhatsappSettingsProvider {
  getPhoneStatus(): Promise<WaPhoneStatus>;
  getProfile(): Promise<WaBusinessProfile>;
  updateProfile(input: WaBusinessProfileInput): Promise<void>;
  /** Resumable upload, then set the returned handle on the profile. */
  uploadProfilePhoto(bytes: Uint8Array, mime: WaPhotoMime): Promise<void>;
  listMessageLinks(): Promise<WaMessageLink[]>;
  createMessageLink(prefilledMessage: string): Promise<WaMessageLink>;
  deleteMessageLink(code: string): Promise<void>;
}

export const WA_PROFILE_LIMITS = {
  about: 139,
  address: 256,
  description: 512,
  email: 128,
  website: 256,
  websites: 2,
  prefilledMessage: 140,
} as const;

export const WA_VERTICALS = [
  "UNDEFINED", "OTHER", "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN",
  "EVENT_PLAN", "FINANCE", "GROCERY", "GOVT", "HOTEL", "HEALTH", "NONPROFIT",
  "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT", "NOT_A_BIZ",
] as const;
