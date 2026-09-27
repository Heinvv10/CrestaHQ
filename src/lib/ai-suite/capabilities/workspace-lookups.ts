import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { PIPELINE_STAGES } from "@/types/deals";
import {
  canSeeTerritory,
  collectVisible,
  scopedCount,
  scopedDocs,
  territoryScopeFor,
} from "@/lib/ai-suite/territory-scope";
import { type AiSuiteCapability } from "./types";
import { str, fmtMoney } from "./helpers";
import { oneLine } from "./text-safety";
import { normalizePhoneE164 } from "@/lib/contacts/phone";

/** find_contacts' partial-match scan: this many visible contacts, newest first. */
const SCAN_CAP = 500;

export const WORKSPACE_LOOKUP_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "find_contacts",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Search this workspace's contacts (name, email, phone, company)",
    description:
      "Search this sub-account's contacts by name, email, phone, or company. Use it to answer 'do I have…' questions, to check for an existing contact before proposing create_contact (avoid duplicates), and to resolve a contact's id before linking a task to them. Exact email and phone matches compare the stored value, so a mixed-case email or a phone stored in an old format may only turn up among the recent contacts.",
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
      const raw = (args.query as string).trim();
      const q = raw.toLowerCase();
      const qDigits = q.replace(/\D/g, "");
      const scope = await territoryScopeFor(ctx);
      const db = getAdminDb();
      const contacts = db.collection("contacts").where("subAccountId", "==", ctx.subAccountId!);
      // Exact matches across EVERY contact first: two equality filters need no
      // composite index. Emails are stored as typed (newer paths lowercase
      // them) and phones as E.164 where they parse, like the write paths do.
      const sub = (await db.doc(`subAccounts/${ctx.subAccountId}`).get()).data();
      const e164 = normalizePhoneE164(raw, sub?.defaultPhoneCountry as string | undefined);
      const exact = await Promise.all([
        raw.includes("@") ? contacts.where("email", "in", [...new Set([raw, q])]).limit(50).get() : null,
        e164 ? contacts.where("phone", "in", [...new Set([e164, raw])]).limit(50).get() : null,
        contacts.where("name", "==", raw).limit(50).get(),
      ]);
      // Then partial matches. Unscoped (agents, admins): the newest contacts, on
      // the (subAccountId, createdAt desc) index the Contacts page orders by, so a
      // contact without createdAt is outside both. Scoped: territory-filtered in
      // the query, so other territories' contacts can't use up the scan.
      const recent = scope.enforce
        ? await scopedDocs(scope, contacts.limit(SCAN_CAP))
        : (await contacts.orderBy("createdAt", "desc").limit(SCAN_CAP).get()).docs;
      const partial = recent.filter((d) => {
        const data = d.data();
        const text = [data.name, data.email, data.company]
          .filter((v): v is string => typeof v === "string")
          .join(" ")
          .toLowerCase();
        if (text.includes(q)) return true;
        const phone =
          typeof data.phone === "string" ? data.phone.replace(/\D/g, "") : "";
        return qDigits.length >= 4 && phone.includes(qDigits);
      });
      const seen = new Set<string>();
      const matches = [...exact.flatMap((snap) => snap?.docs ?? []), ...partial]
        .filter((d) => canSeeTerritory(scope, d.data().territoryId) && !seen.has(d.id) && seen.add(d.id))
        .slice(0, 8);
      // Every contact the caller can see was scanned only when the scan ended short.
      const partialNote =
        recent.length >= SCAN_CAP
          ? `Exact matches (email, phone and full name as stored) were checked across all contacts; partial matches only among ${
              scope.enforce ? `${recent.length} contacts in your territories` : `the ${recent.length} most recently created (a contact with no creation date is only matched exactly)`
            }.`
          : "";
      if (matches.length === 0) {
        return {
          resultText: `No contacts matched “${args.query}”.${partialNote ? ` ${partialNote}` : ""}`,
        };
      }
      const lines = matches.map((d) => {
        const data = d.data();
        const bits = [
          data.email && `email: ${oneLine(data.email)}`,
          data.phone && `phone: ${oneLine(data.phone)}`,
          data.company && `company: ${oneLine(data.company)}`,
        ].filter(Boolean);
        return `- ${oneLine(data.name) || "(unnamed)"} — id: ${d.id}${
          bits.length ? ` (${bits.join(", ")})` : ""
        }`;
      });
      return {
        resultText: `Contacts matching “${args.query}” (${matches.length}):\n${lines.join("\n")}${
          partialNote ? `\n${partialNote}` : ""
        }`,
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
