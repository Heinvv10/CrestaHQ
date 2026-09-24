import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { type AiSuiteCapability } from "./types";
import { str } from "./helpers";

export const ACCESS_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "my_access",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Check which workspaces you can access and your role in each",
    description:
      "Look up which workspaces (sub-accounts) the signed-in user can access and their role in each, plus whether they have agency-level access. Use for questions like 'do I have access to X?', 'what workspaces can I switch to?', or anything about the user's own permissions. It only ever reflects the current user — it cannot look up anyone else, and it cannot change anything.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check your workspace access.",
    execute: async (ctx) => {
      // The caller's OWN membership index — the same list their workspace
      // switcher shows. Keyed by the session uid; the model has no way to
      // point this at another user.
      const snap = await getAdminDb()
        .collection(`userMemberships/${ctx.uid}/subAccounts`)
        .limit(100)
        .get();
      const isAgencyOwner = ctx.subAccountRole === "agencyOwner";
      const lines = snap.docs.map((d) => {
        const data = d.data();
        const marker = d.id === ctx.subAccountId ? " ← this workspace" : "";
        return `- ${data.name ?? d.id}${
          data.accountNumber ? ` (#${data.accountNumber})` : ""
        } — role: ${data.role ?? "member"}${marker}`;
      });
      const agencyLine = isAgencyOwner
        ? "The user is the AGENCY OWNER — full access to every sub-account in the agency (even any not listed above) plus the Agency area (feature gates, creating sub-accounts, agency settings)."
        : "The user does NOT have agency-level access. Only their agency owner can see agency-wide data (e.g. the full list or count of sub-accounts) or change feature gates. To reach another workspace not listed above, they'd need the agency owner to invite them.";
      return {
        resultText: `Workspaces this user can access (${snap.size}):\n${
          lines.length ? lines.join("\n") : "(none listed)"
        }\n\n${agencyLine}\n\nSwitching: the workspace picker in the top header moves between workspaces they belong to.`,
      };
    },
  },
  {
    name: "open_workspace",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel:
      "Switch you to another workspace you belong to (via an open button)",
    description:
      "Give the user a button to open another workspace (sub-account) they already have access to — use when they ask to switch/go/move to a different workspace. This never grants access: it only resolves against workspaces the user is already a member of. You cannot switch them yourself; the button does it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The target workspace's name (or #account-number) as the user said it.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query");
      if (!query)
        return { ok: false, error: "which workspace to open is required" };
      return { ok: true, args: { query: query.slice(0, 120) } };
    },
    summarize: (args) => `Open the “${args.query}” workspace.`,
    execute: async (ctx, args) => {
      const q = (args.query as string).toLowerCase().replace(/^#/, "");
      // The caller's OWN membership index — a link can only ever be built to
      // a workspace they already belong to.
      const snap = await getAdminDb()
        .collection(`userMemberships/${ctx.uid}/subAccounts`)
        .limit(100)
        .get();
      const rows = snap.docs.map((d) => ({
        id: d.id,
        name:
          typeof d.data().name === "string" ? (d.data().name as string) : d.id,
        accountNumber: d.data().accountNumber as number | undefined,
      }));
      const matches = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.accountNumber != null && String(r.accountNumber) === q)
      );
      if (matches.length === 0) {
        return {
          resultText: `None of the workspaces the user can access match “${args.query}”. They can access: ${
            rows.map((r) => r.name).join(", ") || "(none)"
          }. If they need access to another workspace, their agency owner must invite them.`,
        };
      }
      if (matches.length > 1) {
        return {
          resultText: `Multiple accessible workspaces match “${args.query}”: ${matches
            .map(
              (r) =>
                `${r.name}${r.accountNumber ? ` (#${r.accountNumber})` : ""}`
            )
            .join(", ")}. Ask the user which one they mean.`,
        };
      }
      const target = matches[0];
      if (target.id === ctx.subAccountId) {
        return {
          resultText: `“${target.name}” is the workspace the user is already in — no switch needed.`,
        };
      }
      // This resultText is USER-facing: the chat route short-circuits on
      // `navigate` and shows it directly with the button.
      return {
        resultText: `You have access to “${target.name}” — click below to switch. You'll land in that workspace's own assistant, which only sees that client's data.`,
        navigate: {
          href: `/sa/${target.id}/ai-suite`,
          label: `Open ${target.name} →`,
        },
      };
    },
  },
];
