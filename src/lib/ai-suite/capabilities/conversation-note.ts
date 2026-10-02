import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { createMentionTasks } from "@/lib/server/note-mention-tasks";
import { territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { mentionedUidsIn } from "@/lib/conversations/note-mentions";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, assertInTerritory, EMAIL_RE } from "./helpers";
import { agentText, hasUnsafeText, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { tenantContact } from "./contact-edit";

/**
 * add_conversation_note for API agents: the Conversations thread composer's
 * Internal note mode (internal-note-composer.tsx), over the same rows. The
 * note is a contact note (`contacts/{id}/notes`, source "conversation") and
 * reaches no customer. Mentions run the same task side effect as the human
 * path (note-mention-tasks.ts).
 */

/** The composer has no cap; the agent surface does, so a runaway write can't fill a thread. */
const MAX_BODY = 4000;
const MAX_MENTIONS = 10;
const KEYS = new Set(["contactId", "body", "mentions"]);

export const CONVERSATION_NOTE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "add_conversation_note",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Add an internal note to a conversation",
    description:
      `Add an internal note to a contact's conversation thread: staff see it, the customer never does and nothing is sent. Optionally @mention team members by email (they must be active members of this workspace; see list_members): each gets a task, as when a person mentions them. The note must read like a person's: for each mentioned member the tool appends "@<their display name>" to the end of the body unless it is already written there. Body up to ${MAX_BODY} characters, line breaks allowed; up to ${MAX_MENTIONS} mentions.`,
    parameters: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "The contact's id (from find_contacts, or the conversation's contactId)." },
        body: { type: "string", description: "The note text." },
        mentions: {
          type: "array",
          items: { type: "string" },
          description: "Emails of workspace members to @mention.",
        },
      },
      required: ["contactId", "body"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const extra = Object.keys(r).filter((k) => !KEYS.has(k));
      if (extra.length) return { ok: false, error: `unknown argument: ${extra.join(", ")}` };
      if (!isDocId(r.contactId)) return { ok: false, error: "a contactId is required" };
      if (typeof r.body !== "string") return { ok: false, error: "a body is required" };
      const body = agentText("body", r.body).replace(/\r\n?/g, "\n");
      if (!body) return { ok: false, error: "the body can't be empty" };
      // Line breaks are the one control character a note may carry.
      if (hasUnsafeText(body.replace(/\n/g, " "))) return { ok: false, error: `the body ${UNSAFE_TEXT_MESSAGE}` };
      if (body.length > MAX_BODY) return { ok: false, error: `the body must be at most ${MAX_BODY} characters` };
      const args: Record<string, unknown> = { contactId: r.contactId, body };
      if (r.mentions !== undefined) {
        const m = r.mentions;
        if (
          !Array.isArray(m) ||
          m.length > MAX_MENTIONS ||
          !m.every((e) => typeof e === "string" && EMAIL_RE.test(e.trim()))
        ) {
          return { ok: false, error: `mentions must be a list of at most ${MAX_MENTIONS} member email addresses` };
        }
        args.mentions = [...new Set(m.map((e) => (e as string).trim().toLowerCase()))];
      }
      return { ok: true, args };
    },
    summarize: () => "Add an internal note to a conversation.",
    execute: async (ctx, args) => {
      const subAccountId = ctx.subAccountId!;
      const contactId = args.contactId as string;
      const contact = await tenantContact(subAccountId, contactId);
      assertInTerritory(await territoryScopeFor(ctx), contact.territoryId, "That contact");

      // Mentioned members: ACTIVE rows of this sub-account only, by email.
      const emails = (args.mentions as string[] | undefined) ?? [];
      const picked: { uid: string; displayName: string }[] = [];
      if (emails.length) {
        const snap = await getAdminDb()
          .collection(`subAccounts/${subAccountId}/subAccountMembers`)
          .where("status", "==", "active")
          .get();
        for (const email of emails) {
          const d = snap.docs.find((x) => String(x.data().email ?? "").trim().toLowerCase() === email);
          if (!d) throw new CapabilityUserError(`${email} isn't an active member of this workspace, so can't be mentioned.`);
          // The roster's label (GET /members): display name, else the email as stored.
          const stored = String(d.data().email ?? "").trim();
          const displayName = String(d.data().displayName ?? "").trim() || stored;
          picked.push({ uid: d.id, displayName });
        }
      }

      // The composer stores `@Name` in the text for every mention; append any the body lacks.
      let body = args.body as string;
      for (const p of picked) {
        if (!mentionedUidsIn(body, [p]).length) body = `${body} @${p.displayName}`;
      }
      if (hasUnsafeText(body.replace(/\n/g, " ")) || body.length > MAX_BODY) {
        throw new CapabilityUserError(`The note with its @mentions is too long or carries characters that can't be shown safely.`);
      }
      const mentionedUids = [...new Set(picked.map((p) => p.uid))];

      // Same fields as the composer's addNote(), plus the agent stamp. A note
      // with mentions is claimed (mentionTasksAt) as it is written, so the
      // human mention-tasks route can never create a second set.
      await getAdminDb().collection(`contacts/${contactId}/notes`).add({
        content: body,
        createdBy: ctx.uid,
        createdAt: FieldValue.serverTimestamp(),
        source: "conversation",
        ...(mentionedUids.length ? { mentionedUids, mentionTasksAt: FieldValue.serverTimestamp() } : {}),
        ...agentEditStamp(agentActor(ctx, "add_conversation_note")),
      });

      // One call per member, so a failure part-way reports exactly who was and
      // wasn't tasked. The note is already claimed (mentionTasksAt) and the human
      // route refuses agent-authored notes, so there is no retry: the agent must
      // tell a person about anyone not tasked.
      let tasks = "";
      if (picked.length) {
        const tasked: string[] = [];
        const notTasked: string[] = [];
        for (const p of picked) {
          try {
            const ids = await createMentionTasks({
              subAccountId,
              contactId,
              contact,
              content: body,
              rawMentionedUids: [p.uid],
              authorUid: ctx.uid,
              authorName: `API agent ${ctx.apiKey?.keyPrefix ?? ""}`.trim(),
              fallbackAgencyId: ctx.agencyId,
            });
            (ids.length ? tasked : notTasked).push(p.displayName);
          } catch (err) {
            console.error(`[add_conversation_note] sa=${subAccountId} contact=${contactId} mention task for ${p.uid} failed`, err);
            notTasked.push(p.displayName);
          }
        }
        tasks = tasked.length ? ` Mention tasks created for: ${tasked.join(", ")}.` : "";
        if (notTasked.length) {
          tasks += ` NOT tasked: ${notTasked.join(", ")}. The note is saved and can't be retried (do not call this tool again); tell a person to notify them.`;
        }
      }
      return {
        resultText: `Internal note added (nothing was sent).${tasks}`,
        // The audit trail names the contact (AUDIT_TARGET_TYPES has no "note").
        ref: { kind: "contact", id: contactId },
      };
    },
  },
];
