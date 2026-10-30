import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { isCheckoutThemeId } from "@/lib/checkout/themes";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { prepareBookingPage, upcomingBookingCount } from "@/lib/server/booking-page-write";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";
import { CapabilityUserError, type AiSuiteActionContext, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { oneLine } from "./text-safety";
import { assertPageName, assertPageTerritory, FORM_KEYS, formOf, PAGE_PROPS, pageFields, pageRows, slugParam, tenantPage } from "./booking-page-support";

/**
 * update_booking_page for API agents (AGENT_API_V1_PLAN.md, PR12): the
 * booking editor's full-replace save (the stored page with the asked fields
 * changed, through booking-page-write.ts). A draft with no upcoming bookings
 * is edited directly. A published page, an edit that publishes one, or a
 * page with upcoming bookings (whose reminders, cancel and reschedule emails
 * read it live) changes what the public sees, books or is sent, so a
 * sub-account admin approves it (public_change) with
 * every changed field old -> new; the stored page is pinned and re-checked
 * in the write's transaction. The slug never changes (public links).
 */

const EDIT_KEYS = FORM_KEYS.filter((k) => k !== "slug");

async function plan(ctx: AiSuiteActionContext, args: Record<string, unknown>) {
  const { slug, ...fields } = args;
  const page = await tenantPage(ctx.subAccountId!, slug);
  const stored = formOf(page);
  // A stored preset this build doesn't know (a retired id) is dropped, as the editor and the
  // duplicate route do: sent back through the validator it would refuse every edit of the page.
  if (!isCheckoutThemeId(stored.themePreset)) delete stored.themePreset;
  const prepared = await prepareBookingPage(ctx.subAccountId!, { ...stored, ...fields, slug: page.id }, { storedType: page.calendarType });
  if (!prepared.ok) throw new CapabilityUserError(prepared.error);
  if (typeof fields.name === "string") await assertPageName(ctx.subAccountId!, prepared.data.name, page.id);
  if (fields.defaultTerritoryId !== undefined) await assertPageTerritory(ctx.subAccountId!, prepared.data.defaultTerritoryId);
  return { page, data: prepared.data };
}

type QueryGet = (q: FirebaseFirestore.Query) => Promise<FirebaseFirestore.QuerySnapshot>;

/** Is the page (or would it be) seen by the public, or read by messages to booked customers? */
async function isPublic(subAccountId: string, page: BookingPage, status: unknown, get?: QueryGet): Promise<boolean> {
  return page.status === "published" || status === "published" || (await upcomingBookingCount(subAccountId, page.id, get)) > 0;
}

export const BOOKING_PAGE_EDIT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "update_booking_page",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Edit a booking page (a published page: a person approves)",
    description:
      "Change a booking page's fields (as get_booking_page shows them; the slug can't change). Editing a published page, or publishing one, is queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { ...PAGE_PROPS, slug: slugParam }, required: ["slug"], additionalProperties: false },
    validate: (raw) => {
      const slug = str(raw, "slug");
      if (!isDocId(slug)) return { ok: false, error: "a slug is required" };
      const f = pageFields(raw, EDIT_KEYS);
      if (!f.ok) return f;
      if (!Object.keys(f.args).length) return { ok: false, error: "give at least one field to change" };
      return { ok: true, args: { slug, ...f.args } };
    },
    summarize: (args) => `Edit the booking page /${args.slug}.`,
    approvalFor: async (args, ctx) => {
      const page = await tenantPage(ctx.subAccountId!, args.slug);
      return (await isPublic(ctx.subAccountId!, page, args.status)) ? "public_change" : undefined;
    },
    approvalHint: { approval: "public_change", when: "the page is published, the edit publishes it, or bookings on it are upcoming" },
    approvalTarget: async (ctx, args) => {
      await tenantPage(ctx.subAccountId!, args.slug);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const { page, data } = await plan(ctx, args);
      const changed = pageRows(data, formOf(page));
      // Going public, or read by messages to booked customers: the whole
      // resulting page, since earlier direct edits of a draft were never reviewed.
      const whole = (page.status !== "published" && data.status === "published") || (await upcomingBookingCount(ctx.subAccountId!, page.id)) > 0;
      return {
        rows: [
          { label: "Edit", value: `${oneLine(page.name) || "(unnamed)"} (/${page.id}), ${page.status}: the public sees the new version` },
          ...(whole
            ? [{ label: "Changed", value: changed.map((r) => r.label).join(", ") || "nothing" }, ...pageRows(data, null)]
            : changed.length
              ? changed
              : [{ label: "Changes", value: "none (the page is saved as it is)" }]),
        ],
        pinned: { slug: page.id, before: canonical(formOf(page)), after: canonical(data) },
      };
    },
    execute: async (ctx, args) => {
      const { page, data } = await plan(ctx, args);
      const pinned = ctx.approved?.pinned;
      if (pinned && canonical(data) !== pinned.after) throw new CapabilityUserError("The page's settings changed since this was reviewed; nothing was changed.");
      const db = getAdminDb();
      const ref = db.doc(`subAccounts/${ctx.subAccountId}/bookingPages/${page.id}`);
      await db.runTransaction(async (tx) => {
        const current = await tenantPage(ctx.subAccountId!, page.id, (r) => tx.get(r));
        if (pinned) {
          if (canonical(formOf(current)) !== pinned.before) throw new CapabilityUserError("The page was edited since this was reviewed; nothing was changed.");
        } else if (await isPublic(ctx.subAccountId!, current, data.status, (q) => tx.get(q))) {
          throw new CapabilityUserError("This page is published, the edit publishes it, or bookings on it are upcoming, so the change needs approval: send it again.");
        }
        tx.update(ref, {
          ...data,
          territoryId: current.territoryId ?? GLOBAL_TERRITORY_ID,
          updatedAt: FieldValue.serverTimestamp(),
          ...agentEditStamp(agentActor(ctx, "update_booking_page")),
        });
      });
      return { resultText: `Updated the booking page /${page.id}.`, ref: { kind: "bookingPage", id: page.id } };
    },
  },
];
