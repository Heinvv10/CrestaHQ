import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { scopedDocs, territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import {
  ISO_DATE_RE,
  str,
  assertInTerritory,
  subAccountTimezone,
  ymdInTz,
  toDate,
  contactNamesById,
} from "./helpers";

export const TASK_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "create_task",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Create a task, with an optional due date and linked contact",
    description:
      "Create a task (to-do) in this sub-account, optionally with a due date and linked to a contact. Use when the user asks to add/create a task or reminder. To link a contact, resolve their id with find_contacts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the task is." },
        notes: { type: "string", description: "Optional extra detail." },
        dueAt: {
          type: "string",
          description:
            "Optional due date as YYYY-MM-DD. Convert relative dates ('tomorrow', 'next Friday') using today's date from the system prompt.",
        },
        contactId: {
          type: "string",
          description:
            "Optional id of an existing contact to link, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description:
            "The linked contact's name (required when contactId is set).",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "a task title is required" };
      const dueAt = str(raw, "dueAt");
      if (dueAt && (!ISO_DATE_RE.test(dueAt) || isNaN(Date.parse(dueAt)))) {
        return {
          ok: false,
          error: "the due date must be a valid ISO date like 2026-07-10",
        };
      }
      const contactId = str(raw, "contactId");
      return {
        ok: true,
        args: {
          title,
          notes: str(raw, "notes"),
          dueAt,
          contactId,
          contactName: str(raw, "contactName"),
        },
      };
    },
    summarize: (args) =>
      `Create a task “${args.title}”${args.dueAt ? ` due ${args.dueAt}` : ""}${
        args.contactName ? ` linked to ${args.contactName}` : ""
      }.`,
    execute: async (ctx, args) => {
      const contactId = (args.contactId as string) || null;
      if (contactId) {
        // The id came from the model — verify it's a real contact in THIS
        // sub-account before linking, so a wrong/crafted id can't attach the
        // task to another tenant's record.
        const c = await getAdminDb().doc(`contacts/${contactId}`).get();
        if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
          throw new CapabilityUserError(
            "The linked contact wasn't found in this workspace."
          );
        }
        assertInTerritory(
          await territoryScopeFor(ctx),
          c.data()?.territoryId,
          "The linked contact"
        );
      }
      const dueAtStr = (args.dueAt as string) || "";
      const res = await createTaskServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        title: args.title as string,
        notes: (args.notes as string) ?? "",
        // Date-only input → midday UTC, so it lands on the right day in every
        // timezone the operator is likely working from.
        dueAt: dueAtStr ? new Date(`${dueAtStr}T12:00:00Z`) : null,
        contactId,
        dealId: null,
        eventId: null,
      });
      return {
        resultText: `Created task “${args.title}”${
          dueAtStr ? ` due ${dueAtStr}` : ""
        }${args.contactName ? ` linked to ${args.contactName}` : ""}. You'll find it under Tasks.`,
        ref: { kind: "task", id: res.id },
      };
    },
  },
  {
    name: "find_tasks",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See your open tasks — today, overdue, or upcoming",
    description:
      "List this workspace's open (incomplete) tasks, filtered to today / overdue / upcoming, or everything open. Dates are evaluated in the workspace's timezone. Use for questions like 'what's on today?', 'anything overdue?', and ALWAYS use it to resolve a task's id before complete_task — never guess ids. For today's calendar, also call find_events.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["today", "overdue", "upcoming", "all-open"],
          description:
            "'today' = due today; 'overdue' = past due; 'upcoming' = due later; 'all-open' (default) = every incomplete task, grouped.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const filter = str(raw, "filter") || "all-open";
      if (!["today", "overdue", "upcoming", "all-open"].includes(filter)) {
        return {
          ok: false,
          error: "filter must be today, overdue, upcoming, or all-open",
        };
      }
      return { ok: true, args: { filter } };
    },
    summarize: (args) =>
      args.filter === "all-open"
        ? "List all open tasks."
        : `List ${args.filter} tasks.`,
    execute: async (ctx, args) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const today = ymdInTz(new Date(), tz);
      const scope = await territoryScopeFor(ctx);
      const docs = (
        await scopedDocs(
          scope,
          getAdminDb()
            .collection("tasks")
            .where("subAccountId", "==", ctx.subAccountId!)
            .where("completed", "==", false)
            .limit(300)
        )
      ).slice(0, 300);

      type Row = {
        id: string;
        title: string;
        due: string | null; // YYYY-MM-DD in the workspace tz
        contactId: string | null;
      };
      const rows: Row[] = docs.map((d) => {
        const data = d.data();
        const dueAt = toDate(data.dueAt);
        return {
          id: d.id,
          title: (data.title as string) ?? "(untitled)",
          due: dueAt ? ymdInTz(dueAt, tz) : null,
          contactId: typeof data.contactId === "string" ? data.contactId : null,
        };
      });

      const bucketOf = (r: Row) =>
        r.due === null
          ? "no-date"
          : r.due < today
            ? "overdue"
            : r.due === today
              ? "today"
              : "upcoming";
      const wanted =
        args.filter === "all-open"
          ? rows
          : rows.filter((r) => bucketOf(r) === args.filter);
      if (wanted.length === 0) {
        return {
          resultText:
            args.filter === "all-open"
              ? "No open tasks — all clear."
              : `No ${args.filter} tasks.`,
        };
      }

      // Oldest due date first; undated last.
      wanted.sort((a, b) =>
        (a.due ?? "9999-99-99") < (b.due ?? "9999-99-99") ? -1 : 1
      );
      const shown = wanted.slice(0, 15);
      const names = await contactNamesById(
        ctx.subAccountId!,
        shown.map((r) => r.contactId),
        scope
      );
      const line = (r: Row) =>
        `- ${r.title} — id: ${r.id}${
          r.due
            ? `, due ${r.due}${bucketOf(r) === "overdue" ? " (OVERDUE)" : ""}`
            : ", no due date"
        }${
          r.contactId
            ? `, contact: ${names.get(r.contactId) ?? r.contactId}`
            : ""
        }`;

      let body: string;
      if (args.filter === "all-open") {
        const sections = (["overdue", "today", "upcoming", "no-date"] as const)
          .map((bucket) => {
            const items = shown.filter((r) => bucketOf(r) === bucket);
            if (!items.length) return null;
            const label = {
              overdue: "Overdue",
              today: "Due today",
              upcoming: "Upcoming",
              "no-date": "No due date",
            }[bucket];
            return `${label}:\n${items.map(line).join("\n")}`;
          })
          .filter(Boolean);
        body = sections.join("\n");
      } else {
        body = shown.map(line).join("\n");
      }
      const more =
        wanted.length > shown.length
          ? `\n(+${wanted.length - shown.length} more — see the Tasks page)`
          : "";
      return {
        resultText: `Open tasks (${wanted.length}, dates in ${tz}):\n${body}${more}`,
      };
    },
  },
];
