import { Timestamp } from "firebase-admin/firestore";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";

/** Stored booking-page and appointment docs for the PR12 agent tests. */

export const pageForm = (slug: string, patch: Record<string, unknown> = {}) => ({ ...defaultBookingPageFormData(slug, "UTC"), name: "Consult", ...patch });

export const PAGE = { ...pageForm("bp1"), id: "bp1", subAccountId: "sa1", agencyId: "ag1", territoryId: "global", createdByUid: "u1" };

const at = (ms: number) => Timestamp.fromMillis(Date.now() + ms);
export const pastEvent = (patch: Record<string, unknown> = {}) => ({
  subAccountId: "sa1", agencyId: "ag1", title: "Install", contactId: "c1", status: "scheduled", territoryId: "global",
  startAt: at(-3_600_000), endAt: at(-1_800_000), ...patch,
});
