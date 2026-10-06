import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  createInviteServerSide,
  MemberAddBlockedError,
} from "@/lib/server/members-service";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { EMAIL_RE, str } from "./helpers";
import { AGENT_PREVIEW_LABELS, inviteState, invitePreview, keptTerritories } from "./invite-preview";
import { UNSAFE_TEXT_MESSAGE, UNSAFE_TEXT_RE } from "./text-safety";
import { canonical } from "@/lib/server/agent-proposals-encoding";

export const MEMBER_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_members",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel: "List this workspace's members and pending invites",
    description:
      "List this sub-account's members (name, email, role, status) and any pending invites. Use to answer questions about who has access, and ALWAYS use it before invite_member to check the person isn't already a member or already invited.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List this workspace's members and pending invites.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const [membersSnap, invitesSnap] = await Promise.all([
        db
          .collection(`subAccounts/${ctx.subAccountId!}/subAccountMembers`)
          .limit(100)
          .get(),
        db
          .collection("invites")
          .where("subAccountId", "==", ctx.subAccountId!)
          .where("acceptedByUid", "==", null)
          .where("revokedAt", "==", null)
          .limit(50)
          .get(),
      ]);
      const memberLines = membersSnap.docs
        .filter((d) => d.data().status !== "removed")
        .map((d) => {
          const data = d.data();
          const who =
            (data.displayName as string) || (data.email as string) || d.id;
          const email =
            data.displayName && data.email ? ` (${data.email})` : "";
          return `- ${who}${email} — role: ${data.role ?? "member"}${
            data.status && data.status !== "active" ? `, ${data.status}` : ""
          }`;
        });
      const inviteLines = invitesSnap.docs.map((d) => {
        const data = d.data();
        return `- ${data.email} — invited as ${
          data.subAccountRole ?? "collaborator"
        }, pending (hasn't signed up yet)`;
      });
      return {
        resultText: [
          `Members (${memberLines.length}):`,
          memberLines.length ? memberLines.join("\n") : "(none)",
          "",
          `Pending invites (${inviteLines.length}):`,
          inviteLines.length ? inviteLines.join("\n") : "(none)",
        ].join("\n"),
      };
    },
  },
  {
    name: "invite_member",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat", "agent"],
    // On the agent surface every invite waits for a person (A4b): it emails
    // someone, and it can add or re-role a member at once.
    approval: "outbound",
    menuLabel:
      "Invite someone to this workspace by email (as admin or collaborator)",
    description:
      "Add someone (by email) to this sub-account as 'admin' (manages members + settings) or 'collaborator' (works the data, no member management). If the email is NEW, they get an email with a signup link and the invite stays pending until they sign up. If the email ALREADY has a verified account (or is already a member here), they're added to this workspace directly (nothing to accept) and emailed a notification — this is how someone already in another sub-account gets added here. Re-adding an existing member just updates their role. Ask which role the user wants if they didn't say; default to collaborator when they just say 'invite'.",
    parameters: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "The invitee's email address.",
        },
        role: {
          type: "string",
          enum: ["admin", "collaborator"],
          description:
            "'admin' manages members + settings; 'collaborator' works the data only.",
        },
      },
      required: ["email", "role"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const email = str(raw, "email").toLowerCase();
      // The approver reads it through oneLine, which drops invisible
      // characters; the invite would go to the raw address.
      if (UNSAFE_TEXT_RE.test(email)) return { ok: false, error: `the email ${UNSAFE_TEXT_MESSAGE}` };
      // A look-alike letter (Cyrillic, accented) reads as another address.
      if (!/^[!-~]+$/.test(email)) return { ok: false, error: "the email must be plain ASCII letters, digits and symbols" };
      if (!email || !EMAIL_RE.test(email)) {
        return { ok: false, error: "a valid email address is required" };
      }
      const role = str(raw, "role");
      if (role !== "admin" && role !== "collaborator") {
        return {
          ok: false,
          error: "the role must be 'admin' or 'collaborator'",
        };
      }
      return { ok: true, args: { email, role } };
    },
    // Neutral: what happens depends on the account, and the proposing key
    // must not learn it (the approver reads it in the preview).
    summarize: (args) =>
      `Invite ${args.email} to this workspace as ${
        args.role === "admin" ? "an admin" : "a collaborator"
      }.`,
    agentPreviewLabels: AGENT_PREVIEW_LABELS,
    approvalTarget: async () => ({ contactId: null, territoryId: null, scoped: false }),
    preview: (ctx, args) =>
      invitePreview(ctx.subAccountId!, ctx.agencyId, args.email as string, args.role as "admin" | "collaborator"),
    execute: async (ctx, args) => {
      if (ctx.apiKey && !ctx.approved) {
        throw new CapabilityUserError("Inviting someone needs a person's approval; propose it again.");
      }
      const pinned = ctx.approved?.pinned;
      let territories: string[] | null = null;
      if (ctx.approved) {
        // What the approver reviewed, checked again now: the claim came
        // after the last preview check, and the account or its territories
        // may have changed.
        const state = await inviteState(ctx.subAccountId!, String(pinned?.email));
        territories = (await keptTerritories(ctx.subAccountId!, state, String(pinned?.role))).ids;
        if (
          pinned?.email !== args.email ||
          pinned?.role !== args.role ||
          canonical(state) !== canonical(pinned?.state) ||
          canonical(territories) !== canonical(pinned?.territories)
        ) {
          throw new CapabilityUserError("This person's membership changed since it was reviewed; propose it again.");
        }
        if (state.kind === "blocked") throw new CapabilityUserError(state.reason);
      }
      let res;
      try {
        res = await createInviteServerSide({
          subAccountId: ctx.subAccountId!,
          invitedByUid: ctx.uid,
          // Approved: the approving person did it. Chat: the assistant made
          // the change; createdByUid records who asked it.
          auditActor: ctx.approved ? { type: "user", id: ctx.uid } : { type: "ai_agent", id: "workspace-assistant" },
          email: (pinned?.email ?? args.email) as string,
          role: (pinned?.role ?? args.role) as "admin" | "collaborator",
          // Approved: an existing membership's or pending invite's territories stay as they are.
          ...(territories ? { assignedTerritoryIds: territories } : {}),
        });
      } catch (err) {
        if (err instanceof MemberAddBlockedError) {
          throw new CapabilityUserError(err.message);
        }
        throw err;
      }
      const roleLabel = res.role === "admin" ? "Admin" : "Collaborator";

      // Existing account → added directly (no signup step).
      if (res.added) {
        if (res.alreadyMember) {
          return {
            resultText: `${res.email} was already a member of “${res.subAccountName}” — their role is now ${roleLabel}.`,
            ref: { kind: "subAccount", id: res.subAccountId },
          };
        }
        const note = res.mailed ? " They've been emailed a notification." : "";
        return {
          resultText: `Added ${res.email} to “${res.subAccountName}” as ${roleLabel} (they already had an account, so there was nothing to accept).${note}`,
          ref: { kind: "sub-account", id: res.subAccountId },
        };
      }

      // New email → pending invite until they sign up.
      const reusedNote = res.reused
        ? " There was already a pending invite for them — it's been updated to this role and re-sent."
        : "";
      const delivery = res.mailed
        ? `The invite email is on its way.`
        : `No email was sent (${
            res.mailError
              ? "the send failed"
              : "email isn't configured on this deployment"
          }) — copy their invite link from Settings → Members → Pending invites and share it with them directly.`;
      return {
        resultText: `Invited ${res.email} to “${res.subAccountName}” as ${roleLabel}.${reusedNote} ${delivery} Pending invites are managed under Settings → Members.`,
        ref: { kind: "invite", id: res.inviteId },
      };
    },
  },
];
