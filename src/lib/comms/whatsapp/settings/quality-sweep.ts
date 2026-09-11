import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { SubAccountDoc } from "@/types";
import type { StoredQuality } from "@/types/whatsapp-cloud";
import { recordQualityDrop, resolveOpenAlerts } from "./quality-alert";
import { WaFakeRefusedError, getWhatsappSettingsProviderFor, whatsappSettingsProviderMode } from "./select";
import type { WaPhoneStatus } from "./types";

/**
 * The hourly quality poll behind POST /api/cron/whatsapp-quality: every
 * sub-account on the Cloud rail with a connected number gets its phone-number
 * node read and the reading stored on `whatsappCloudMeta.quality`. An alert
 * fires ONLY on a drop from GREEN (docs/parity/sp15.md §4): recovery closes
 * the open alert quietly, and a first reading has nothing to have dropped
 * from. Each tenant is isolated — one throw is counted and the sweep goes on.
 *
 * Single-field query only (no composite index): `whatsappProvider == "cloud"`,
 * then the phone-number id is checked in memory. In fake mode the query is
 * fenced to WHATSAPP_FAKE_AGENCY_ID instead, so a dev or CI box pointed at
 * production Firestore never reads a real tenant; select.ts still asserts
 * per tenant.
 */

export interface QualityTransition {
  reading: StoredQuality;
  alert: "drop" | "recovered" | null;
}

const BAD = new Set(["YELLOW", "RED"]);

/** Pure: the stored reading → the next one, and whether anything happened. */
export function evaluateQualityTransition(
  prev: StoredQuality | null,
  next: WaPhoneStatus,
  now: Date,
): QualityTransition {
  const rating = next.qualityRating;
  const reading: StoredQuality = {
    rating,
    nameStatus: next.nameStatus,
    status: next.status,
    checkedAt: now,
    changedAt: prev && prev.rating === rating ? prev.changedAt : now,
  };
  if (!prev) return { reading, alert: null };
  if (prev.rating === "GREEN" && BAD.has(rating)) return { reading, alert: "drop" };
  if (BAD.has(prev.rating) && rating === "GREEN") return { reading, alert: "recovered" };
  return { reading, alert: null };
}

export interface QualitySweepResult {
  processed: number;
  alerted: number;
  recovered: number;
  failed: number;
}

type Candidate = { id: string; sub: SubAccountDoc };

async function candidates(): Promise<Candidate[]> {
  // Throws WaFakeRefusedError on a misconfigured fake: the sweep cannot
  // start, the route answers 500, QStash retries — loudly.
  const fake = whatsappSettingsProviderMode() === "fake";
  const subs = getAdminDb().collection("subAccounts");
  const query = fake
    ? subs.where("agencyId", "==", process.env.WHATSAPP_FAKE_AGENCY_ID)
    : subs.where("whatsappProvider", "==", "cloud");
  return (await query.get()).docs
    .map((d) => ({ id: d.id, sub: d.data() as SubAccountDoc }))
    .filter(({ sub }) => sub.whatsappProvider === "cloud" && !!sub.whatsappCloudMeta?.phoneNumberId);
}

async function pollOne(c: Candidate, now: Date): Promise<"drop" | "recovered" | null> {
  const meta = c.sub.whatsappCloudMeta!;
  const provider = await getWhatsappSettingsProviderFor(c.id);
  const next = await provider.getPhoneStatus();
  const { reading, alert } = evaluateQualityTransition(meta.quality ?? null, next, now);
  await getAdminDb()
    .doc(`subAccounts/${c.id}`)
    .set({ whatsappCloudMeta: { quality: reading } }, { merge: true });
  if (alert === "drop") {
    await recordQualityDrop({
      subAccountId: c.id,
      sub: c.sub,
      from: meta.quality!.rating,
      to: reading.rating,
      phoneNumberId: meta.phoneNumberId!,
      displayPhoneNumber: next.displayPhoneNumber ?? meta.displayPhoneNumber,
      now,
    });
  } else if (alert === "recovered") {
    await resolveOpenAlerts(c.id, now);
  }
  return alert;
}

export async function runWhatsappQualitySweep(
  opts: { now?: Date } = {},
): Promise<QualitySweepResult> {
  const now = opts.now ?? new Date();
  const list = await candidates();
  const result: QualitySweepResult = { processed: 0, alerted: 0, recovered: 0, failed: 0 };
  for (const c of list) {
    try {
      const alert = await pollOne(c, now);
      result.processed += 1;
      if (alert === "drop") result.alerted += 1;
      if (alert === "recovered") result.recovered += 1;
    } catch (err) {
      // Outside the fake's fence, or Meta refused, or Firestore failed:
      // that tenant's reading stays as it was and the next hour retries.
      const kind = err instanceof WaFakeRefusedError ? "fake refused" : "poll threw";
      console.error(`[whatsapp-quality] ${kind} sa=${c.id}: ${err instanceof Error ? err.name : typeof err}`);
      result.failed += 1;
    }
  }
  return result;
}
