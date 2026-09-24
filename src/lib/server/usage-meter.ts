import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type {
  UsageMonthDoc,
  UsageQuotas,
  UsageRates,
  UsageUnit,
} from "@/types/usage";

/**
 * Usage Metering v1 — the single write/check path for the per-workspace
 * usage ledger (`subAccounts/{id}/usage/{YYYY-MM}`). See
 * USAGE_METERING_V1_PLAN.md for the locked scope.
 *
 * Design rules this file enforces:
 *  - `recordUsage` is BEST-EFFORT: it logs and swallows every failure so
 *    a metering outage can never block a customer-facing send.
 *  - `checkQuota` FAILS OPEN: any resolution/read error means "allowed".
 *  - Default is unlimited — with no quotas configured anywhere, the only
 *    effect of this module is counters accruing.
 *  - Voice quotas are configured in MINUTES, compared in seconds.
 */

interface QuotaSubjectSubAccount {
  agencyId?: string;
  usageQuotas?: UsageQuotas | null;
  usageRates?: UsageRates | null;
  billing?: { planId?: string | null } | null;
  name?: string;
}

const UNIT_META: Record<
  UsageUnit,
  { quotaKey: keyof UsageQuotas; label: string; quotaFactor: number }
> = {
  emailsSent: { quotaKey: "emailsPerMonth", label: "email", quotaFactor: 1 },
  smsSegments: {
    quotaKey: "smsSegmentsPerMonth",
    label: "SMS segment",
    quotaFactor: 1,
  },
  whatsappMessages: {
    quotaKey: "whatsappPerMonth",
    label: "WhatsApp message",
    quotaFactor: 1,
  },
  aiTokens: { quotaKey: "aiTokensPerMonth", label: "AI token", quotaFactor: 1 },
  // Configured in minutes, ledger counts seconds.
  voiceSeconds: {
    quotaKey: "voiceMinutesPerMonth",
    label: "voice minute",
    quotaFactor: 60,
  },
};

export function usageMonthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthRef(subAccountId: string, month: string) {
  return getAdminDb().doc(`subAccounts/${subAccountId}/usage/${month}`);
}

/* ------------------------------------------------------------------ */
/* Quota resolution (workspace override → plan → unlimited)            */
/* ------------------------------------------------------------------ */

/** 5-minute in-memory caches so per-send overhead stays near zero. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const _planQuotaCache = new Map<
  string,
  { quotas: UsageQuotas | null; rates: UsageRates | null; at: number }
>();
const _subCache = new Map<
  string,
  { sub: QuotaSubjectSubAccount | null; at: number }
>();

async function loadSubAccount(
  subAccountId: string,
): Promise<QuotaSubjectSubAccount | null> {
  const cached = _subCache.get(subAccountId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.sub;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = snap.exists ? (snap.data() as QuotaSubjectSubAccount) : null;
  _subCache.set(subAccountId, { sub, at: Date.now() });
  return sub;
}

async function loadPlanBilling(
  agencyId: string,
  planId: string,
): Promise<{ quotas: UsageQuotas | null; rates: UsageRates | null }> {
  const key = `${agencyId}/${planId}`;
  const cached = _planQuotaCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { quotas: cached.quotas, rates: cached.rates };
  }
  const snap = await getAdminDb()
    .doc(`agencies/${agencyId}/plans/${planId}`)
    .get();
  const quotas = (snap.data()?.quotas as UsageQuotas | undefined) ?? null;
  const rates = (snap.data()?.rates as UsageRates | undefined) ?? null;
  _planQuotaCache.set(key, { quotas, rates, at: Date.now() });
  return { quotas, rates };
}

/**
 * Effective quotas for a workspace: its own `usageQuotas` override wins,
 * else the assigned plan's `quotas`, else null (unlimited). Pass the
 * sub-account doc when in hand to skip a (cached) read.
 */
export async function getEffectiveQuotas(
  subAccountId: string,
  subAccount?: QuotaSubjectSubAccount | null,
): Promise<UsageQuotas | null> {
  const sub = subAccount ?? (await loadSubAccount(subAccountId));
  if (!sub) return null;
  if (sub.usageQuotas) return sub.usageQuotas;
  const planId = sub.billing?.planId;
  if (planId && sub.agencyId) {
    return (await loadPlanBilling(sub.agencyId, planId)).quotas;
  }
  return null;
}

/** Effective overage rates: workspace override → plan → null. */
export async function getEffectiveRates(
  subAccountId: string,
  subAccount?: QuotaSubjectSubAccount | null,
): Promise<UsageRates | null> {
  const sub = subAccount ?? (await loadSubAccount(subAccountId));
  if (!sub) return null;
  if (sub.usageRates) return sub.usageRates;
  const planId = sub.billing?.planId;
  if (planId && sub.agencyId) {
    return (await loadPlanBilling(sub.agencyId, planId)).rates;
  }
  return null;
}

/**
 * Value the month's usage BEYOND the included quotas at the configured
 * sell rates. Overage only exists past a quota (no quota = unlimited
 * included = nothing billable), and only counts when a rate is set for
 * that unit. Display/accrual only in v1.5 — nothing here moves money.
 */
export function computeOverage(
  usage: UsageMonthDoc,
  quotas: UsageQuotas | null,
  rates: UsageRates | null,
): {
  perUnit: Partial<Record<UsageUnit, { overUnits: number; cents: number }>>;
  totalCents: number;
} {
  const perUnit: Partial<
    Record<UsageUnit, { overUnits: number; cents: number }>
  > = {};
  let totalCents = 0;
  if (!quotas || !rates) return { perUnit, totalCents };

  const entries: {
    unit: UsageUnit;
    rateKey: keyof UsageRates;
    /** cents for `over` ledger units at `rate` cents-per-configured-unit */
    cents: (over: number, rate: number) => number;
  }[] = [
    { unit: "emailsSent", rateKey: "emailCents", cents: (o, r) => o * r },
    { unit: "smsSegments", rateKey: "smsSegmentCents", cents: (o, r) => o * r },
    {
      unit: "whatsappMessages",
      rateKey: "whatsappMessageCents",
      cents: (o, r) => o * r,
    },
    {
      unit: "aiTokens",
      rateKey: "aiTokensPer1kCents",
      cents: (o, r) => (o / 1000) * r,
    },
    {
      unit: "voiceSeconds",
      rateKey: "voiceMinuteCents",
      cents: (o, r) => (o / 60) * r,
    },
  ];

  for (const e of entries) {
    const limit = limitFor(quotas, e.unit);
    const rate = rates[e.rateKey];
    if (limit === null) continue;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      continue;
    }
    const used = usage[e.unit] ?? 0;
    const overUnits = Math.max(0, used - limit);
    if (overUnits <= 0) continue;
    const cents = Math.round(e.cents(overUnits, rate));
    perUnit[e.unit] = { overUnits, cents };
    totalCents += cents;
  }
  return { perUnit, totalCents };
}

/** Sanitize an inbound rates payload — same contract as quotas. */
export function sanitizeUsageRates(raw: unknown): UsageRates | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: UsageRates = {};
  const keys: (keyof UsageRates)[] = [
    "emailCents",
    "smsSegmentCents",
    "whatsappMessageCents",
    "aiTokensPer1kCents",
    "voiceMinuteCents",
  ];
  for (const key of keys) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[key] = Math.round(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Quota limit in LEDGER units (minutes→seconds), or null = unlimited. */
function limitFor(quotas: UsageQuotas | null, unit: UsageUnit): number | null {
  if (!quotas) return null;
  const raw = quotas[UNIT_META[unit].quotaKey];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw) * UNIT_META[unit].quotaFactor;
}

/* ------------------------------------------------------------------ */
/* Enforcement                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sanitize an inbound quotas payload (plan editor / workspace override).
 * Keeps only known keys with positive finite integers; anything else is
 * dropped. Returns null when nothing valid remains ( = unlimited).
 */
export function sanitizeUsageQuotas(raw: unknown): UsageQuotas | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: UsageQuotas = {};
  const keys: (keyof UsageQuotas)[] = [
    "emailsPerMonth",
    "smsSegmentsPerMonth",
    "whatsappPerMonth",
    "aiTokensPerMonth",
    "voiceMinutesPerMonth",
  ];
  for (const key of keys) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[key] = Math.floor(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Thrown by send chokepoints when a workspace's monthly cap is hit. */
export class UsageQuotaExceededError extends Error {
  readonly unit: UsageUnit;
  constructor(unit: UsageUnit) {
    const { label } = UNIT_META[unit];
    super(
      `Monthly ${label} limit reached for this workspace. It resets at the start of next month, or the limit can be raised by the platform owner.`,
    );
    this.name = "UsageQuotaExceededError";
    this.unit = unit;
  }
}

/**
 * Is this workspace allowed one more unit of spend? FAILS OPEN — any
 * error resolves to allowed, because a metering blip must never take a
 * client's channels down.
 */
export async function checkQuota(input: {
  subAccountId: string;
  unit: UsageUnit;
  subAccount?: QuotaSubjectSubAccount | null;
}): Promise<{ allowed: boolean; error?: UsageQuotaExceededError }> {
  try {
    const quotas = await getEffectiveQuotas(input.subAccountId, input.subAccount);
    const limit = limitFor(quotas, input.unit);
    if (limit === null) return { allowed: true };
    const snap = await monthRef(input.subAccountId, usageMonthKey()).get();
    const used = (snap.data() as UsageMonthDoc | undefined)?.[input.unit] ?? 0;
    if (used >= limit) {
      return { allowed: false, error: new UsageQuotaExceededError(input.unit) };
    }
    return { allowed: true };
  } catch (err) {
    console.warn("[usage-meter] checkQuota failed (failing open)", {
      subAccountId: input.subAccountId,
      unit: input.unit,
      err,
    });
    return { allowed: true };
  }
}

/* ------------------------------------------------------------------ */
/* Recording + owner alerts                                            */
/* ------------------------------------------------------------------ */

/**
 * Increment the workspace's month ledger. Best-effort — never throws.
 * When a quota exists for the unit, opportunistically evaluates the
 * 80%/100% thresholds and emails the agency owner ONCE per unit per
 * month (stamped on the doc). No push in v1: the push pipeline
 * broadcasts to workspace members, which is the wrong audience for a
 * quota alert.
 */
export async function recordUsage(input: {
  subAccountId: string;
  unit: UsageUnit;
  qty: number;
  subAccount?: QuotaSubjectSubAccount | null;
}): Promise<void> {
  try {
    const qty = Math.floor(input.qty);
    if (!Number.isFinite(qty) || qty <= 0) return;
    const month = usageMonthKey();
    const ref = monthRef(input.subAccountId, month);
    await ref.set(
      {
        [input.unit]: FieldValue.increment(qty),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Alert evaluation — only costs a read when a quota is configured.
    const quotas = await getEffectiveQuotas(input.subAccountId, input.subAccount);
    const limit = limitFor(quotas, input.unit);
    if (limit === null) return;
    const snap = await ref.get();
    const data = (snap.data() as UsageMonthDoc | undefined) ?? {};
    const used = data[input.unit] ?? 0;
    const pct = (used / limit) * 100;
    if (pct >= 100 && !data.cappedAt?.[input.unit]) {
      await ref.set(
        { cappedAt: { [input.unit]: FieldValue.serverTimestamp() } },
        { merge: true },
      );
      void notifyOwner(input.subAccountId, input.unit, 100, used, limit);
    } else if (pct >= 80 && !data.warnedAt?.[input.unit]) {
      await ref.set(
        { warnedAt: { [input.unit]: FieldValue.serverTimestamp() } },
        { merge: true },
      );
      void notifyOwner(input.subAccountId, input.unit, 80, used, limit);
    }
  } catch (err) {
    console.warn("[usage-meter] recordUsage failed", {
      subAccountId: input.subAccountId,
      unit: input.unit,
      err,
    });
  }
}

function formatUnits(unit: UsageUnit, n: number): string {
  if (unit === "voiceSeconds") return `${Math.round(n / 60)} min`;
  return n.toLocaleString();
}

async function notifyOwner(
  subAccountId: string,
  unit: UsageUnit,
  threshold: 80 | 100,
  used: number,
  limit: number,
): Promise<void> {
  try {
    // Dynamic import: resend.ts meters email sends through this module,
    // so a static import back would be a cycle.
    const { noPlatformSender, resolvePlatformSender, sendPlatformEmail } =
      await import("@/lib/comms/platform-email");
    const sender = await resolvePlatformSender(subAccountId);
    if (!sender) {
      noPlatformSender("[usage-meter] owner alert", subAccountId);
      return;
    }
    const db = getAdminDb();
    const sub = await loadSubAccount(subAccountId);
    if (!sub?.agencyId) return;
    const agencySnap = await db.doc(`agencies/${sub.agencyId}`).get();
    const ownerUid = agencySnap.data()?.ownerUid as string | undefined;
    let to: string | null = null;
    if (ownerUid) {
      const ownerSnap = await db.doc(`users/${ownerUid}`).get();
      to = (ownerSnap.data()?.email as string | undefined) ?? null;
    }
    to = to ?? (agencySnap.data()?.supportEmail as string | undefined) ?? null;
    if (!to) return;

    const { label } = UNIT_META[unit];
    const wsName = sub.name || subAccountId;
    const subject =
      threshold === 100
        ? `${wsName} hit its monthly ${label} limit`
        : `${wsName} has used 80% of its monthly ${label} quota`;
    const text = [
      `${wsName} — ${label} usage this month: ${formatUnits(unit, used)} of ${formatUnits(unit, limit)}.`,
      "",
      threshold === 100
        ? `That channel's sends are now paused for this workspace until the month resets, or until you raise the limit (Sub-accounts → Manage → Usage).`
        : `At 100% that channel's sends pause for this workspace. Raise the limit under Sub-accounts → Manage → Usage if needed.`,
    ].join("\n");
    await sendPlatformEmail(sender, { to, subject, text });
  } catch (err) {
    console.warn("[usage-meter] owner alert failed", { subAccountId, unit, err });
  }
}
