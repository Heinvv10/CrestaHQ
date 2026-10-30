import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  sanitiseButtons,
  sanitiseVariables,
} from "@/lib/comms/whatsapp/template-validation";
import { templateRegistration } from "@/lib/comms/whatsapp/template-registrations";
import { loadContactCustomFieldKeys } from "@/lib/custom-fields/load-defs";
import type {
  WhatsappTemplateButton,
  WhatsappTemplateCategory,
  WhatsappTemplateDoc,
} from "@/types/whatsapp-templates";

export const dynamic = "force-dynamic";

/**
 * Edit / delete a single WhatsApp template. Only mutable while NOT live —
 * i.e. status is draft, rejected, or failed (Meta makes approved templates
 * immutable; to change an approved one you create a new template). Editing a
 * rejected/failed template resets it to draft so the operator can fix + resubmit.
 */

const EDITABLE: ReadonlyArray<string> = ["draft", "rejected", "failed"];
const RAILS = ["twilio", "cloud", "bridge"] as const;
const VALID_CATEGORIES: WhatsappTemplateCategory[] = [
  "UTILITY",
  "MARKETING",
  "AUTHENTICATION",
];

/**
 * Whether a PATCH would change what the recipient reads, compared after the
 * normalisation a save applies — the manager always sends every field, so a
 * rename must not count as a content edit.
 */
function changesContent(body: PatchBody, existing: WhatsappTemplateDoc): boolean {
  if (typeof body.body === "string" && body.body.trim().slice(0, 1024) !== existing.body) return true;
  if (typeof body.language === "string" && (body.language.trim() || "en").slice(0, 12) !== existing.language) return true;
  if (body.buttons !== undefined) {
    const next = sanitiseButtons(body.buttons, existing.category);
    if ("error" in next) return true;
    const key = (buttons: WhatsappTemplateButton[]) =>
      JSON.stringify(buttons.map((b) => [b.type, b.text, b.type === "url" ? b.url : null]));
    if (key(next.buttons) !== key(existing.buttons ?? [])) return true;
  }
  return false;
}

interface PatchBody {
  displayName?: string;
  category?: string;
  language?: string;
  body?: string;
  variables?: unknown;
  buttons?: unknown;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; templateId: string }> },
) {
  const { id: subAccountId, templateId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const ref = getAdminDb().doc(
    `subAccounts/${subAccountId}/whatsappTemplates/${templateId}`,
  );
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  const existing = snap.data() as WhatsappTemplateDoc;
  if (!EDITABLE.includes(existing.status)) {
    return NextResponse.json(
      {
        error: `A ${existing.status} template can't be edited. Create a new template instead.`,
      },
      { status: 409 },
    );
  }

  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // The flat status is one rail's. A template still approved (or awaiting
  // approval) on another sends THAT rail's stored content, so changing what
  // the recipient reads here would make every preview show text that isn't
  // what goes out.
  if (changesContent(body, existing)) {
    for (const rail of RAILS) {
      const status = templateRegistration(existing, rail)?.status;
      if (status === "approved" || status === "pending") {
        return NextResponse.json(
          {
            error: `This template is ${status} on ${rail}, so its text, buttons and language can't change. Create a new template instead.`,
          },
          { status: 409 },
        );
      }
    }
  }

  const nextBody = (body.body ?? existing.body).trim();
  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    // Editing a rejected/failed template returns it to draft.
    status: "draft",
    rejectionReason: null,
  };

  if (typeof body.displayName === "string") {
    const dn = body.displayName.trim();
    if (!dn) return NextResponse.json({ error: "displayName can't be empty" }, { status: 400 });
    updates.displayName = dn.slice(0, 120);
  }
  if (typeof body.category === "string") {
    const cat = body.category.toUpperCase() as WhatsappTemplateCategory;
    if (!VALID_CATEGORIES.includes(cat)) {
      return NextResponse.json({ error: "Invalid category" }, { status: 400 });
    }
    updates.category = cat;
  }
  if (typeof body.language === "string") {
    updates.language = (body.language.trim() || "en").slice(0, 12);
  }
  if (typeof body.body === "string") {
    if (!nextBody) return NextResponse.json({ error: "body can't be empty" }, { status: 400 });
    updates.body = nextBody.slice(0, 1024);
  }
  // Re-validate variables against the (possibly new) body whenever either
  // body or variables changed.
  if (body.variables !== undefined || typeof body.body === "string") {
    const rawVars = body.variables ?? existing.variables;
    const sanitised = sanitiseVariables(
      rawVars,
      nextBody,
      await loadContactCustomFieldKeys(subAccountId),
    );
    if ("error" in sanitised) {
      return NextResponse.json({ error: sanitised.error }, { status: 400 });
    }
    updates.variables = sanitised.variables;
  }
  // Re-validated when the category changes too: buttons already on a draft
  // must not ride along into a category Meta refuses them on.
  if (body.buttons !== undefined || typeof body.category === "string") {
    const buttons = sanitiseButtons(
      body.buttons ?? existing.buttons,
      (updates.category as string | undefined) ?? existing.category,
    );
    if ("error" in buttons) {
      return NextResponse.json({ error: buttons.error }, { status: 400 });
    }
    updates.buttons = buttons.buttons;
  }

  // Only onto the doc as read: a submit that started meanwhile registers the
  // content it read, and this edit must not slip in under it.
  try {
    await ref.update(updates, { lastUpdateTime: snap.updateTime });
  } catch (err) {
    if ((err as { code?: unknown }).code === 9) {
      return NextResponse.json(
        { error: "The template changed while saving. Reload and try again." },
        { status: 409 },
      );
    }
    throw err;
  }
  const updated = await ref.get();
  return NextResponse.json({ ok: true, template: { id: ref.id, ...updated.data() } });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; templateId: string }> },
) {
  const { id: subAccountId, templateId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const ref = getAdminDb().doc(
    `subAccounts/${subAccountId}/whatsappTemplates/${templateId}`,
  );
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }
  const existing = snap.data() as WhatsappTemplateDoc;
  // Don't allow deleting a pending/approved template — it exists in Twilio/Meta
  // and an in-flight approval or live template shouldn't be silently orphaned.
  if (existing.status === "pending" || existing.status === "approved") {
    return NextResponse.json(
      {
        error: `A ${existing.status} template can't be deleted from here. Pause or disable it in Twilio first.`,
      },
      { status: 409 },
    );
  }
  await ref.delete();
  return NextResponse.json({ ok: true });
}
