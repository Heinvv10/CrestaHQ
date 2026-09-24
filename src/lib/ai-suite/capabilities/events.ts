import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createEventServerSide } from "@/lib/server/events-service";
import { utcFromWallClock } from "@/lib/booking/availability";
import {
  collectVisible,
  territoryScopeFor,
} from "@/lib/ai-suite/territory-scope";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import {
  ISO_DATE_RE,
  str,
  assertInTerritory,
  TIME_24H_RE,
  subAccountTimezone,
  ymdInTz,
  fmtInTz,
  toDate,
  contactNamesById,
} from "./helpers";

export const EVENT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "find_events",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See what's on the calendar — today, this week, or upcoming",
    description:
      "List this workspace's upcoming calendar events (today / next 7 days / everything upcoming), in the workspace's timezone. Use for questions like 'what's on today?' or 'what does my week look like?'. Pair with find_tasks for a full daily agenda.",
    parameters: {
      type: "object",
      properties: {
        range: {
          type: "string",
          enum: ["today", "week", "all-upcoming"],
          description:
            "'today' = rest of today; 'week' (default) = the next 7 days; 'all-upcoming' = everything from now on.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const range = str(raw, "range") || "week";
      if (!["today", "week", "all-upcoming"].includes(range)) {
        return {
          ok: false,
          error: "range must be today, week, or all-upcoming",
        };
      }
      return { ok: true, args: { range } };
    },
    summarize: (args) =>
      args.range === "today"
        ? "List today's calendar events."
        : args.range === "week"
          ? "List this week's calendar events."
          : "List all upcoming calendar events.",
    execute: async (ctx, args) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const now = new Date();
      // Window end: midnight (workspace tz) after today / after day 7.
      // Calendar day arithmetic runs through Date.UTC so month/year roll over.
      const [y, m, d] = ymdInTz(now, tz).split("-").map(Number);
      const endOf = (daysAhead: number) => {
        const rolled = new Date(Date.UTC(y, m - 1, d + daysAhead + 1));
        return utcFromWallClock(
          rolled.getUTCFullYear(),
          rolled.getUTCMonth() + 1,
          rolled.getUTCDate(),
          0,
          tz
        );
      };
      const windowEnd =
        args.range === "today"
          ? endOf(0)
          : args.range === "week"
            ? endOf(6)
            : null;

      // Uses the existing events(subAccountId, startAt) composite index.
      let q = getAdminDb()
        .collection("events")
        .where("subAccountId", "==", ctx.subAccountId!)
        .where("startAt", ">=", now);
      if (windowEnd) q = q.where("startAt", "<", windowEnd);
      // Territory-filtered before the 50 cap (a range + `in` would need an
      // index this collection lacks, so a scoped caller pages instead).
      const scope = await territoryScopeFor(ctx);
      const { docs, scanCapped } = await collectVisible(
        scope,
        q.orderBy("startAt", "asc"),
        { want: 50, maxScan: 1000 }
      );

      const partial = scanCapped
        ? "\n(Only the next 1000 calendar entries were checked — see the Calendar page for later ones.)"
        : "";
      const rows = docs.filter((doc) => doc.data().status !== "cancelled");
      if (rows.length === 0) {
        return {
          resultText: `${
            args.range === "today"
              ? "Nothing (left) on the calendar today."
              : args.range === "week"
                ? "Nothing on the calendar in the next 7 days."
                : "No upcoming calendar events."
          }${partial}`,
        };
      }
      const shown = rows.slice(0, 15);
      const names = await contactNamesById(
        ctx.subAccountId!,
        shown.map((doc) =>
          typeof doc.data().contactId === "string"
            ? (doc.data().contactId as string)
            : null
        ),
        scope
      );
      const lines = shown.map((doc) => {
        const data = doc.data();
        const startAt = toDate(data.startAt);
        const contactId =
          typeof data.contactId === "string" ? data.contactId : null;
        return `- ${data.title ?? "(untitled)"} — ${
          startAt ? fmtInTz(startAt, tz) : "(no time)"
        }${data.location ? `, at ${data.location}` : ""}${
          contactId ? `, contact: ${names.get(contactId) ?? contactId}` : ""
        }`;
      });
      const more =
        rows.length > shown.length
          ? `\n(+${rows.length - shown.length} more — see the Calendar page)`
          : "";
      return {
        resultText: `Upcoming events (${rows.length}, times in ${tz}):\n${lines.join("\n")}${more}${partial}`,
      };
    },
  },
  {
    name: "create_event",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel:
      "Book a calendar event (date + time, optionally linked to a contact)",
    description:
      "Create a calendar event in this workspace. The date and time are interpreted in the WORKSPACE's timezone. Convert relative dates ('tomorrow', 'next Friday') using today's date from the system prompt, and ask for a time if the user didn't give one. To link a contact, resolve their id with find_contacts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "What the event is, e.g. 'Call with Jane'.",
        },
        date: { type: "string", description: "Event date as YYYY-MM-DD." },
        time: {
          type: "string",
          description:
            "Start time as 24-hour HH:MM in the workspace timezone, e.g. 14:00.",
        },
        durationMinutes: {
          type: "number",
          description: "Optional length in minutes (5–480). Defaults to 60.",
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
        location: {
          type: "string",
          description: "Optional location or meeting spot.",
        },
        notes: { type: "string", description: "Optional extra detail." },
      },
      required: ["title", "date", "time"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "an event title is required" };
      const date = str(raw, "date");
      if (!ISO_DATE_RE.test(date) || isNaN(Date.parse(date))) {
        return {
          ok: false,
          error: "the date must be a valid ISO date like 2026-07-10",
        };
      }
      const time = str(raw, "time");
      if (!TIME_24H_RE.test(time)) {
        return {
          ok: false,
          error: "the time must be 24-hour HH:MM, e.g. 14:00",
        };
      }
      const rawDuration = (raw as Record<string, unknown>)?.durationMinutes;
      const duration =
        rawDuration === undefined || rawDuration === null
          ? 60
          : typeof rawDuration === "number"
            ? rawDuration
            : Number(rawDuration);
      if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
        return {
          ok: false,
          error: "the duration must be between 5 and 480 minutes",
        };
      }
      return {
        ok: true,
        args: {
          title,
          date,
          time,
          durationMinutes: Math.round(duration),
          contactId: str(raw, "contactId"),
          contactName: str(raw, "contactName"),
          location: str(raw, "location").slice(0, 200),
          notes: str(raw, "notes").slice(0, 2000),
        },
      };
    },
    summarize: (args) =>
      `Create the event “${args.title}” on ${args.date} at ${args.time} (${args.durationMinutes} min, workspace time)${
        args.contactName ? ` with ${args.contactName}` : ""
      }.`,
    execute: async (ctx, args) => {
      const contactId = (args.contactId as string) || null;
      if (contactId) {
        // The id came from the model — verify it's in THIS workspace.
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
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const [y, m, d] = (args.date as string).split("-").map(Number);
      const [hh, mm] = (args.time as string).split(":").map(Number);
      const startAt = utcFromWallClock(y, m, d, hh * 60 + mm, tz);
      const endAt = new Date(
        startAt.getTime() + (args.durationMinutes as number) * 60_000
      );
      const res = await createEventServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        title: args.title as string,
        startAt,
        endAt,
        contactId,
        location: (args.location as string) ?? "",
        notes: (args.notes as string) ?? "",
      });
      return {
        resultText: `Booked “${args.title}” for ${fmtInTz(startAt, tz)} (${tz}, ${args.durationMinutes} min)${
          args.contactName ? ` with ${args.contactName}` : ""
        }. You'll see it on the Calendar.`,
        ref: { kind: "event", id: res.id },
      };
    },
  },
];
