import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  requireSubAccountAdmin,
  requireSubAccountMember,
} from "@/lib/auth/require-tenancy";
import { listWhatsappSenders } from "@/lib/comms/whatsapp/resolve-sender";
import {
  validateSenderInput,
  withSingleDefault,
} from "@/lib/comms/whatsapp/sender-registry";
import {
  MAX_WHATSAPP_SENDERS,
  type WhatsAppSender,
} from "@/types/whatsapp-senders";
import type { SubAccountDoc } from "@/types";

/**
 * The sub-account's WhatsApp sender registry — the numbers a workflow step can
 * choose to send from.
 *
 * GET    — list. Member-readable; display metadata only, never a credential.
 * POST   — add a sender. Admin only.
 * PATCH  — edit one, or make it the default. Admin only.
 * DELETE — remove one (`?senderId=`). Admin only.
 *
 * The list lives on the sub-account doc (`whatsappSenders`), so every write
 * rewrites the whole array through the Admin SDK. Exactly one sender carries
 * `isDefault` — enforced on every write, because two defaults means a step
 * with no `senderId` picks by array order.
 *
 * Every write is read-modify-write over that one array, so it runs inside a
 * transaction. Two admins saving at once otherwise interleave into a lost
 * sender or two defaults — the invariant would hold in the code and not in the
 * document.
 */

/** Thrown inside the write transaction to abort it with an HTTP status. */
class SenderWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SenderWriteError";
  }
}

async function loadSubAccount(
  subAccountId: string,
): Promise<SubAccountDoc | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.exists ? (snap.data() as SubAccountDoc) : null;
}

/**
 * The three writes share everything but the mutation: admin auth, then a
 * transaction that re-reads the sub-account, re-checks the agency gate, and
 * commits the new array. `mutate` runs inside the transaction and may be run
 * again on contention, so it must stay a pure function of the doc it is given
 * — it is, because the registry rules live in `sender-registry.ts`.
 */
async function writeSenders(
  request: Request,
  subAccountId: string,
  mutate: (sub: SubAccountDoc) => WhatsAppSender[],
): Promise<NextResponse> {
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}`);
  try {
    const senders = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new SenderWriteError(404, "Sub-account not found");
      const sub = snap.data() as SubAccountDoc;
      if (sub.whatsappEnabledByAgency !== true) {
        throw new SenderWriteError(
          403,
          "WhatsApp isn't enabled for this workspace. Ask your agency to turn it on.",
        );
      }
      const next = mutate(sub);
      tx.set(
        ref,
        { whatsappSenders: next, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return next;
    });
    return NextResponse.json({ ok: true, senders });
  } catch (err) {
    if (err instanceof SenderWriteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const sub = await loadSubAccount(subAccountId);
  if (!sub) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  // Through the resolver, so the list a picker renders is the list a send
  // resolves against — including the synthesized sender of a workspace that
  // has never touched the registry.
  return NextResponse.json({
    ok: true,
    senders: listWhatsappSenders(sub),
    /** True while the single sender above is synthesized, not stored. */
    synthesized: !sub.whatsappSenders?.length,
  });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const validated = validateSenderInput(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const sender: WhatsAppSender = {
    id: crypto.randomUUID(),
    label: validated.value.label,
    provider: validated.value.provider,
    phoneNumber: validated.value.phoneNumber,
  };

  return writeSenders(request, subAccountId, (sub) => {
    // Adding the FIRST sender materialises the registry from the rail the
    // workspace already runs on, so the numbers it sends from today keep
    // working and the new one is an addition rather than a replacement.
    const existing = sub.whatsappSenders?.length
      ? sub.whatsappSenders
      : listWhatsappSenders(sub).filter((s) => s.phoneNumber);
    if (existing.length >= MAX_WHATSAPP_SENDERS) {
      throw new SenderWriteError(
        400,
        `A workspace can have at most ${MAX_WHATSAPP_SENDERS} senders.`,
      );
    }
    if (existing.some((s) => s.phoneNumber === sender.phoneNumber)) {
      throw new SenderWriteError(
        409,
        "That number is already a sender on this workspace.",
      );
    }
    return withSingleDefault(
      [...existing, sender],
      validated.value.isDefault ? sender.id : undefined,
    );
  });
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch = (body ?? {}) as Record<string, unknown>;
  const senderId = typeof patch.id === "string" ? patch.id : "";

  return writeSenders(request, subAccountId, (sub) => {
    const existing = sub.whatsappSenders ?? [];
    const target = existing.find((s) => s.id === senderId);
    if (!target) throw new SenderWriteError(404, "Sender not found");

    // A default-only PATCH carries no other field, so validation runs against
    // the sender's current values merged with whatever was sent.
    const validated = validateSenderInput({
      label: patch.label ?? target.label,
      provider: patch.provider ?? target.provider,
      phoneNumber: patch.phoneNumber ?? target.phoneNumber,
    });
    if (!validated.ok) throw new SenderWriteError(400, validated.error);
    if (
      existing.some(
        (s) => s.id !== senderId && s.phoneNumber === validated.value.phoneNumber,
      )
    ) {
      throw new SenderWriteError(
        409,
        "That number is already a sender on this workspace.",
      );
    }

    const updated = existing.map((s) =>
      s.id === senderId
        ? {
            ...s,
            label: validated.value.label,
            provider: validated.value.provider,
            phoneNumber: validated.value.phoneNumber,
          }
        : s,
    );
    return withSingleDefault(
      updated,
      patch.isDefault === true ? senderId : undefined,
    );
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const senderId = new URL(request.url).searchParams.get("senderId") ?? "";

  return writeSenders(request, subAccountId, (sub) => {
    const existing = sub.whatsappSenders ?? [];
    if (!existing.some((s) => s.id === senderId)) {
      throw new SenderWriteError(404, "Sender not found");
    }
    // Steps still pointing at it now fail loudly at resolve time rather than
    // sending from a different number.
    return withSingleDefault(existing.filter((s) => s.id !== senderId));
  });
}
