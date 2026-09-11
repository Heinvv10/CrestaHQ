import type { StoredQuality, WaQualityRating } from "@/types/whatsapp-cloud";
import type {
  WaBusinessProfile,
  WaMessageLink,
  WaPhoneStatus,
} from "@/lib/comms/whatsapp/settings/types";

/** What GET /api/sub-accounts/[id]/whatsapp/status answers. */
export interface WaStatusResponse {
  phone: WaPhoneStatus;
  meta: { displayPhoneNumber: string | null; verifiedName: string | null; phoneNumberId: string | null };
  quality: StoredQuality | null;
  openAlert: { from: WaQualityRating; to: WaQualityRating; createdAt: string | null } | null;
}

export type { WaBusinessProfile, WaMessageLink, WaPhoneStatus, WaQualityRating };

export const RATING_LABEL: Record<WaQualityRating, string> = {
  GREEN: "Green",
  YELLOW: "Yellow",
  RED: "Red",
  UNKNOWN: "Unknown",
};

/** Meta's `vertical` enum with the labels the Profile tab's picker shows. */
export const VERTICAL_LABELS: Array<[string, string]> = [
  ["UNDEFINED", "Not set"],
  ["OTHER", "Other"],
  ["AUTO", "Automotive"],
  ["BEAUTY", "Beauty, spa and salon"],
  ["APPAREL", "Clothing and apparel"],
  ["EDU", "Education"],
  ["ENTERTAIN", "Entertainment"],
  ["EVENT_PLAN", "Event planning and service"],
  ["FINANCE", "Finance and banking"],
  ["GROCERY", "Food and grocery"],
  ["GOVT", "Public service"],
  ["HOTEL", "Hotel and lodging"],
  ["HEALTH", "Medical and health"],
  ["NONPROFIT", "Non-profit"],
  ["PROF_SERVICES", "Professional services"],
  ["RETAIL", "Shopping and retail"],
  ["TRAVEL", "Travel and transportation"],
  ["RESTAURANT", "Restaurant"],
  ["NOT_A_BIZ", "Not a business"],
];

export function verticalLabel(vertical: string): string {
  return VERTICAL_LABELS.find(([v]) => v === vertical)?.[1] ?? vertical;
}

/** Read a JSON error body → message, with a fallback. */
export async function errorOf(res: Response | null, fallback: string): Promise<string> {
  const data = (await res?.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}
