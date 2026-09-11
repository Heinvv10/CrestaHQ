import "server-only";

import { randomBytes } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { toMillis } from "@/lib/gbp/sync/types";
import type { GbpWidgetMeta } from "@/types/google";
import type { WidgetConfig } from "./origins";

/**
 * The public reviews widget: ONE per sub-account.
 *
 *   gbpWidgets/{publicId}           server-only config (no client rule → default deny)
 *   subAccounts/{id}.gbpWidgetMeta  member-readable copy for the dashboard card
 *
 * `publicId` is 24 random bytes, base64url — opaque, and never derived from a
 * tenant id, so a feed URL reveals nothing about who it belongs to. Every
 * change writes the doc and the meta in ONE transaction.
 */

export const widgetPath = (publicId: string) => `gbpWidgets/${publicId}`;
export const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{32}$/;
const newPublicId = () => randomBytes(24).toString("base64url");

export interface GbpWidgetDoc extends WidgetConfig {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicWidget {
  publicId: string;
  enabled: boolean;
  allowedOrigins: string[];
  maxReviews: number;
  updatedAt: string | null;
}

/** What the admin routes return — explicit fields, never a spread. */
export function publicWidget(meta: GbpWidgetMeta | null | undefined): PublicWidget | null {
  if (!meta) return null;
  const ms = toMillis(meta.updatedAt);
  return {
    publicId: meta.publicId,
    enabled: meta.enabled,
    allowedOrigins: [...meta.allowedOrigins],
    maxReviews: meta.maxReviews,
    updatedAt: ms === null ? null : new Date(ms).toISOString(),
  };
}

const subRef = (subAccountId: string) => getAdminDb().doc(`subAccounts/${subAccountId}`);

export async function readWidgetMeta(subAccountId: string): Promise<GbpWidgetMeta | null> {
  return ((await subRef(subAccountId).get()).data()?.gbpWidgetMeta as GbpWidgetMeta | undefined) ?? null;
}

/** Create the widget, or update the existing one in place (same publicId). */
export async function saveWidget(subAccountId: string, byUid: string, config: WidgetConfig): Promise<GbpWidgetMeta> {
  const db = getAdminDb();
  return db.runTransaction(async (tx) => {
    const sub = (await tx.get(subRef(subAccountId))).data() ?? {};
    const current = (sub.gbpWidgetMeta as GbpWidgetMeta | null | undefined)?.publicId ?? null;
    const publicId = current ?? newPublicId();
    const ref = db.doc(widgetPath(publicId));
    const existing = current ? ((await tx.get(ref)).data() as GbpWidgetDoc | undefined) : undefined;
    const now = new Date();
    const doc: GbpWidgetDoc = {
      agencyId: sub.agencyId,
      subAccountId,
      createdByUid: existing?.createdByUid ?? byUid,
      enabled: config.enabled,
      allowedOrigins: config.allowedOrigins,
      maxReviews: config.maxReviews,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const meta: GbpWidgetMeta = { publicId, ...config, updatedAt: now };
    tx.set(ref, doc);
    tx.set(subRef(subAccountId), { gbpWidgetMeta: meta }, { merge: true });
    return meta;
  });
}

/** New publicId, same config; the old id stops resolving at once. Null when there is no widget. */
export async function rotateWidget(subAccountId: string): Promise<GbpWidgetMeta | null> {
  const db = getAdminDb();
  return db.runTransaction(async (tx) => {
    const sub = (await tx.get(subRef(subAccountId))).data() ?? {};
    const meta = sub.gbpWidgetMeta as GbpWidgetMeta | null | undefined;
    if (!meta) return null;
    const oldRef = db.doc(widgetPath(meta.publicId));
    const old = (await tx.get(oldRef)).data() as GbpWidgetDoc | undefined;
    const now = new Date();
    const next: GbpWidgetMeta = {
      publicId: newPublicId(),
      enabled: meta.enabled,
      allowedOrigins: meta.allowedOrigins,
      maxReviews: meta.maxReviews,
      updatedAt: now,
    };
    tx.set(db.doc(widgetPath(next.publicId)), {
      agencyId: sub.agencyId,
      subAccountId,
      createdByUid: old?.createdByUid ?? null,
      enabled: meta.enabled,
      allowedOrigins: meta.allowedOrigins,
      maxReviews: meta.maxReviews,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    });
    tx.delete(oldRef);
    tx.set(subRef(subAccountId), { gbpWidgetMeta: next }, { merge: true });
    return next;
  });
}

/** Delete the widget and clear the meta. Idempotent. */
export async function revokeWidget(subAccountId: string): Promise<void> {
  const db = getAdminDb();
  await db.runTransaction(async (tx) => {
    const sub = (await tx.get(subRef(subAccountId))).data() ?? {};
    const meta = sub.gbpWidgetMeta as GbpWidgetMeta | null | undefined;
    if (meta) tx.delete(db.doc(widgetPath(meta.publicId)));
    tx.set(subRef(subAccountId), { gbpWidgetMeta: null }, { merge: true });
  });
}
