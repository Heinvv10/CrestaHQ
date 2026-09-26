import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { prepareBookingPage, upcomingBookingCount } from "@/lib/server/booking-page-write";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { BookingPage } from "@/types/booking";
import { CapabilityUserError, type AiSuiteActionContext, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { oneLine } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";
import { assertPageName, assertPageTerritory, formOf, PAGE_PROPS, pageFields, pageRows, slugParam, tenantPage } from "./booking-page-support";

/**
 * Booking pages for API agents (AGENT_API_V1_PLAN.md, PR12): list and read;
 * create one through the booking-page routes' own checks
 * (booking-page-write.ts) as a direct write while it is a draft, but with a
 * person's approval (public_change) when it is created published, since the
 * public can then book it; delete with an admin's approval, refused while
 * bookings are upcoming. Editing: booking-page-edit.ts. Admin-only writes,
 * like the routes.
 */

async function planCreate(ctx: AiSuiteActionContext, args: Record<string, unknown>) {
  const prepared = await prepareBookingPage(ctx.subAccountId!, args);
  if (!prepared.ok) throw new CapabilityUserError(prepared.error);
  await assertPageName(ctx.subAccountId!, prepared.data.name, null);
  await assertPageTerritory(ctx.subAccountId!, prepared.data.defaultTerritoryId);
  return prepared;
}

export const BOOKING_PAGE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_booking_pages",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List booking pages",
    description: "List the sub-account's booking pages: slug, name, status (draft or published) and meeting length.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List booking pages.",
    execute: async (ctx) => {
      const snap = await getAdminDb().collection(`subAccounts/${ctx.subAccountId}/bookingPages`).get();
      if (snap.empty) return { resultText: "No booking pages." };
      const lines = snap.docs
        .map((d) => d.data() as BookingPage)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((p) => `- ${oneLine(p.name) || "(unnamed)"} \u2014 slug: ${p.slug}, ${p.status}, ${p.durationMinutes} min`);
      return { resultText: `Booking pages (${lines.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "get_booking_page",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "Read a booking page",
    description: "Read a booking page's settings: times, questions, hosts, reminders, payment and confirmation text.",
    parameters: { type: "object", properties: { slug: slugParam }, required: ["slug"], additionalProperties: false },
    validate: (raw) => {
      const slug = str(raw, "slug");
      return isDocId(slug) ? { ok: true, args: { slug } } : { ok: false, error: "a slug is required" };
    },
    summarize: () => "Read a booking page.",
    execute: async (ctx, args) => {
      const p = await tenantPage(ctx.subAccountId!, args.slug);
      return { resultText: pageRows(formOf(p), null).map((r) => `${r.label}: ${r.value}`).join("\n") };
    },
  },
  {
    name: "create_booking_page",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Create a booking page (published: a person approves)",
    description:
      "Create a booking page with the booking editor's fields (slug, name, workingHours, timezone... as get_booking_page shows them). A draft is created directly; status published (bookable by the public) is queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: PAGE_PROPS, required: ["slug", "name"], additionalProperties: false },
    validate: (raw) => pageFields(raw),
    summarize: (args) => `Create the booking page \u201c${args.name}\u201d.`,
    approvalFor: (args) => (args.status === "published" ? "public_change" : undefined),
    approvalHint: { approval: "public_change", when: "status=published" },
    approvalTarget: async () => ({ contactId: null, territoryId: null, scoped: false }),
    preview: async (ctx, args) => {
      const { data } = await planCreate(ctx, args);
      return {
        rows: [{ label: "Create", value: `A published booking page, bookable at /${data.slug} once approved` }, ...pageRows(data, null)],
        pinned: { page: canonical(data) },
      };
    },
    execute: async (ctx, args) => {
      const { data, agencyId } = await planCreate(ctx, args);
      if (ctx.approved ? canonical(data) !== ctx.approved.pinned?.page : data.status === "published") {
        throw new CapabilityUserError(ctx.approved ? "The page's settings changed since this was reviewed; it was not created." : "A published page needs approval: send it again.");
      }
      const territoryId = data.defaultTerritoryId && data.defaultTerritoryId !== GLOBAL_TERRITORY_ID ? data.defaultTerritoryId : GLOBAL_TERRITORY_ID;
      const ref = getAdminDb().doc(`subAccounts/${ctx.subAccountId}/bookingPages/${data.slug}`);
      const now = FieldValue.serverTimestamp();
      try {
        await ref.create({
          ...data, id: data.slug, agencyId, subAccountId: ctx.subAccountId, createdByUid: ctx.uid, territoryId, createdAt: now, updatedAt: now,
          ...agentEditStamp(agentActor(ctx, "create_booking_page")),
        });
      } catch (err) {
        const code = (err as { code?: number | string } | null)?.code;
        if (code === 6 || code === "already-exists") throw new CapabilityUserError(`A booking page with the slug "${data.slug}" already exists. Pick another.`);
        throw err;
      }
      return { resultText: `Created the booking page /${data.slug} (${data.status}).`, ref: { kind: "bookingPage", id: data.slug } };
    },
  },
  {
    name: "delete_booking_page",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a booking page (a person approves)",
    description: "Delete a booking page permanently. Refused while bookings on it are upcoming. Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { slug: slugParam }, required: ["slug"], additionalProperties: false },
    validate: (raw) => {
      const slug = str(raw, "slug");
      return isDocId(slug) ? { ok: true, args: { slug } } : { ok: false, error: "a slug is required" };
    },
    summarize: () => "Delete a booking page.",
    approvalTarget: async (ctx, args) => {
      await tenantPage(ctx.subAccountId!, args.slug);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const p = await tenantPage(ctx.subAccountId!, args.slug);
      const upcoming = await upcomingBookingCount(ctx.subAccountId!, p.id);
      if (upcoming) throw new CapabilityUserError(`Can't delete: ${upcoming} upcoming booking(s) still use this page. Cancel them first, or unpublish the page.`);
      return [
        { label: "Delete booking page", value: `${oneLine(p.name) || "(unnamed)"} (/${p.id}), ${p.status}` },
        ...recordProvenanceRows(p.id, p),
        ...pageRows(formOf(p), null),
        { label: "Then", value: "Its public link stops working; past bookings keep their records." },
      ];
    },
    execute: async (ctx, args) => {
      const p = await tenantPage(ctx.subAccountId!, args.slug);
      const db = getAdminDb();
      const ref = db.doc(`subAccounts/${ctx.subAccountId}/bookingPages/${p.id}`);
      // Upcoming bookings are counted again in the delete's own transaction.
      await db.runTransaction(async (tx) => {
        if (!(await tx.get(ref)).exists) throw new CapabilityUserError("That booking page isn't in this workspace.");
        if (await upcomingBookingCount(ctx.subAccountId!, p.id, (q) => tx.get(q))) {
          throw new CapabilityUserError("A booking on this page is now upcoming; it was not deleted.");
        }
        tx.delete(ref);
      });
      return { resultText: "Deleted the booking page.", ref: { kind: "bookingPage", id: p.id } };
    },
  },
];
