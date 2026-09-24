import "server-only";

import { createContactServerSide } from "@/lib/server/contacts-service";
import { type AiSuiteCapability } from "./types";
import { EMAIL_RE, str, agentActor } from "./helpers";

export const CONTACT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "create_contact",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Add a new contact (with optional tags)",
    description:
      "Add a new contact to this sub-account. Use when the user asks to add/create a contact, lead, or person. Check for an existing contact with find_contacts first so you don't create a duplicate.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact's full name." },
        email: { type: "string", description: "Optional email address." },
        phone: { type: "string", description: "Optional phone number." },
        company: { type: "string", description: "Optional company name." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Optional tags to apply, e.g. ["vip", "referral"].',
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name) return { ok: false, error: "a contact name is required" };
      const email = str(raw, "email").toLowerCase();
      if (email && !EMAIL_RE.test(email)) {
        return { ok: false, error: "that email address doesn't look valid" };
      }
      const rawTags = (raw as Record<string, unknown>)?.tags;
      const tags = Array.isArray(rawTags)
        ? rawTags
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 10)
        : [];
      return {
        ok: true,
        args: {
          name,
          email,
          phone: str(raw, "phone"),
          company: str(raw, "company"),
          tags,
        },
      };
    },
    summarize: (args) => {
      const tags = args.tags as string[] | undefined;
      return `Add a new contact “${args.name}”${args.email ? ` (${args.email})` : ""}${
        tags && tags.length ? ` tagged ${tags.join(", ")}` : ""
      }.`;
    },
    execute: async (ctx, args) => {
      const res = await createContactServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        name: args.name as string,
        email: (args.email as string) ?? "",
        phone: (args.phone as string) ?? "",
        company: (args.company as string) ?? "",
        address: "",
        source: "ai-suite",
        tags: (args.tags as string[]) ?? [],
        actor: agentActor(ctx, "create_contact"),
      });
      return {
        resultText: `Added contact “${args.name}”. Open Contacts to see the full profile.`,
        ref: { kind: "contact", id: res.id },
        ...(res.held ? { held: res.held, holdFailures: res.holdFailures ?? [] } : {}),
      };
    },
  },
];
