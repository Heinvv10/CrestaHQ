import "server-only";

import { MAX_TAGS } from "@/lib/api/serializers/contacts";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { contactIdParam, parseTags, tenantContact, TAGS_RULE, withHeld, writeContact } from "./contact-edit";

/**
 * add_tags / remove_tags for API agents (AGENT_API_V1_PLAN.md, PR7). Two
 * literal registry entries (so scripts/check-capability-tenancy.mjs sees
 * each one's `ctx.subAccountId` anchor) over shared helpers. The new tag
 * list is computed from the contact as stored, inside the write's
 * transaction; a tag an agent adds fires contact.tag.added with its actor,
 * so the enrolment is held for approval.
 */

const tagParameters = {
  type: "object",
  properties: {
    contactId: contactIdParam,
    tags: { type: "array", items: { type: "string" }, description: 'Tags, e.g. ["vip"].' },
  },
  required: ["contactId", "tags"],
  additionalProperties: false,
};

const validateTagArgs: AiSuiteCapability["validate"] = (raw) => {
  const contactId = str(raw, "contactId");
  if (!contactId) return { ok: false, error: "a contactId is required" };
  const tags = parseTags((raw as Record<string, unknown>)?.tags);
  if (!tags || tags.length === 0) return { ok: false, error: `tags must be ${TAGS_RULE}, and not empty` };
  return { ok: true, args: { contactId, tags } };
};

/** Apply `next` (the new tag list from the stored one) to one contact. */
async function changeTags(
  ctx: Parameters<AiSuiteCapability["execute"]>[0],
  subAccountId: string,
  capability: string,
  args: Record<string, unknown>,
  next: (have: string[], given: string[]) => string[]
) {
  const contactId = args.contactId as string;
  const contact = await tenantContact(subAccountId, contactId);
  let tags: string[] = [];
  const res = await writeContact(ctx, capability, contactId, (stored) => {
    const have: string[] = Array.isArray(stored.tags) ? stored.tags : [];
    tags = next(have, args.tags as string[]);
    // Only a GROWING list is capped: a contact already past the cap (the
    // workflow add_tag step, bulk tagging and upsert have none) can still
    // have tags removed.
    if (tags.length > MAX_TAGS && tags.length > have.length) throw new CapabilityUserError(`A contact can carry at most ${MAX_TAGS} tags.`);
    return { tags };
  });
  return {
    resultText: `Tags on “${contact.name ?? "the contact"}” are now: ${tags.join(", ") || "(none)"}.`,
    ref: { kind: "contact", id: contactId },
    ...withHeld(res),
  };
}

export const CONTACT_TAG_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "add_tags",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Tag a contact",
    description:
      "Add tags to a contact, keeping its existing tags. A workflow a tag would start is queued for a person to approve.",
    parameters: tagParameters,
    validate: validateTagArgs,
    summarize: (args) => `Add tag(s) ${(args.tags as string[]).join(", ")} to a contact.`,
    execute: (ctx, args) =>
      changeTags(ctx, ctx.subAccountId!, "add_tags", args, (have, given) => [...new Set([...have, ...given])]),
  },
  {
    name: "remove_tags",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Remove tags from a contact",
    description: "Remove tags from a contact (exact match); tags it doesn't have are ignored.",
    parameters: tagParameters,
    validate: validateTagArgs,
    summarize: (args) => `Remove tag(s) ${(args.tags as string[]).join(", ")} from a contact.`,
    execute: (ctx, args) =>
      changeTags(ctx, ctx.subAccountId!, "remove_tags", args, (have, given) => have.filter((t) => !given.includes(t))),
  },
];
