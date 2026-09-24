import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { PIPELINE_STAGES } from "@/types/deals";
import {
  collectVisible,
  scopedCount,
  scopedDocs,
  territoryScopeFor,
} from "@/lib/ai-suite/territory-scope";
import { type AiSuiteCapability } from "./types";
import { str, fmtMoney } from "./helpers";

export const WORKSPACE_LOOKUP_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "find_contacts",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Search this workspace's contacts (name, email, phone, company)",
    description:
      "Search this sub-account's contacts by name, email, phone, or company. Use it to answer 'do I have…' questions, to check for an existing contact before proposing create_contact (avoid duplicates), and to resolve a contact's id before linking a task to them.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name, email, phone, or company fragment to search for.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query");
      if (!query) return { ok: false, error: "a search term is required" };
      return { ok: true, args: { query: query.slice(0, 120) } };
    },
    summarize: (args) => `Search contacts for “${args.query}”.`,
    execute: async (ctx, args) => {
      const q = (args.query as string).toLowerCase();
      const qDigits = q.replace(/\D/g, "");
      const scope = await territoryScopeFor(ctx);
      const docs = await scopedDocs(
        scope,
        getAdminDb()
          .collection("contacts")
          .where("subAccountId", "==", ctx.subAccountId!)
          .limit(500)
      );
      const matches = docs
        .filter((d) => {
          const data = d.data();
          const text = [data.name, data.email, data.company]
            .filter((v): v is string => typeof v === "string")
            .join(" ")
            .toLowerCase();
          if (text.includes(q)) return true;
          const phone =
            typeof data.phone === "string" ? data.phone.replace(/\D/g, "") : "";
          return qDigits.length >= 4 && phone.includes(qDigits);
        })
        .slice(0, 8);
      if (matches.length === 0) {
        return {
          resultText: `No contacts matched “${args.query}”${
            docs.length >= 500
              ? " (searched the 500 most recently indexed contacts)"
              : ""
          }.`,
        };
      }
      const lines = matches.map((d) => {
        const data = d.data();
        const bits = [
          data.email && `email: ${data.email}`,
          data.phone && `phone: ${data.phone}`,
          data.company && `company: ${data.company}`,
        ].filter(Boolean);
        return `- ${data.name ?? "(unnamed)"} — id: ${d.id}${
          bits.length ? ` (${bits.join(", ")})` : ""
        }`;
      });
      return {
        resultText: `Contacts matching “${args.query}” (${matches.length}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "workspace_stats",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel:
      "Get a workspace snapshot — pipeline by stage with values, contacts, open/overdue tasks, upcoming events",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    description:
      "Get a snapshot of this workspace: deal counts + values per pipeline stage, total contacts, open and overdue tasks, upcoming calendar events, and quotes. Use for questions like 'how's my pipeline?', 'how many leads do I have?', or 'what's overdue?'.",
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Get a snapshot of this workspace.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const said = ctx.subAccountId!;
      const now = new Date();
      // Every figure counts only records the caller's territories cover.
      const scope = await territoryScopeFor(ctx);
      const upcomingQuery = db
        .collection("events")
        .where("subAccountId", "==", said)
        .where("startAt", ">=", now);

      const [
        contactsCount,
        quotesCount,
        upcomingEvents,
        dealsDocs,
        openTaskDocs,
      ] = await Promise.all([
        scopedCount(
          scope,
          db.collection("contacts").where("subAccountId", "==", said)
        ),
        scopedCount(
          scope,
          db.collection("quotes").where("subAccountId", "==", said)
        ),
        // A range + `in` needs an index this collection lacks, so a scoped
        // caller's upcoming events are counted by paging (capped at 1000).
        scope.enforce
          ? collectVisible(scope, upcomingQuery.orderBy("startAt", "asc"), {
              want: 1000,
              maxScan: 1000,
            }).then((r) => ({
              count: r.docs.length,
              capped: r.docs.length >= 1000 || r.scanCapped,
            }))
          : upcomingQuery
              .count()
              .get()
              .then((r) => ({ count: r.data().count, capped: false })),
        scopedDocs(
          scope,
          db.collection("deals").where("subAccountId", "==", said).limit(1000)
        ).then((d) => d.slice(0, 1000)),
        scopedDocs(
          scope,
          db
            .collection("tasks")
            .where("subAccountId", "==", said)
            .where("completed", "==", false)
            .limit(500)
        ).then((d) => d.slice(0, 500)),
      ]);

      // Pipeline rollup in memory (bounded by the 1000-deal cap above).
      const byStage = new Map<string, { count: number; value: number }>();
      let currency = "USD";
      for (const d of dealsDocs) {
        const data = d.data();
        const stage = (data.stageId as string) ?? "new";
        const row = byStage.get(stage) ?? { count: 0, value: 0 };
        row.count += 1;
        row.value += typeof data.value === "number" ? data.value : 0;
        byStage.set(stage, row);
        if (typeof data.currency === "string" && data.currency)
          currency = data.currency;
      }
      const stageLines = PIPELINE_STAGES.map((s) => {
        const row = byStage.get(s.id);
        return `  - ${s.label}: ${row?.count ?? 0}${
          row?.value ? ` (${fmtMoney(row.value, currency)})` : ""
        }`;
      });
      const openValue = PIPELINE_STAGES.filter(
        (s) => s.id !== "won" && s.id !== "lost"
      ).reduce((sum, s) => sum + (byStage.get(s.id)?.value ?? 0), 0);

      let overdue = 0;
      for (const t of openTaskDocs) {
        const dueAt = t.data().dueAt;
        const due =
          dueAt && typeof dueAt.toDate === "function"
            ? (dueAt.toDate() as Date)
            : null;
        if (due && due < now) overdue += 1;
      }

      return {
        resultText: [
          `Workspace snapshot:`,
          `- Contacts: ${contactsCount}`,
          `- Pipeline (${dealsDocs.length} deals${
            dealsDocs.length === 1000 ? ", capped at 1000" : ""
          }, open value ${fmtMoney(openValue, currency)}):`,
          ...stageLines,
          `- Open tasks: ${openTaskDocs.length}${overdue ? ` (${overdue} overdue)` : ""}`,
          `- Upcoming calendar events: ${upcomingEvents.count}${
            upcomingEvents.capped ? " (capped at 1000)" : ""
          }`,
          `- Quotes: ${quotesCount}`,
        ].join("\n"),
      };
    },
  },
];
