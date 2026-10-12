import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { getGroupById } from "@/lib/server/community-service";
import {
  createCourseServerSide,
  createLessonServerSide,
  createSectionServerSide,
  deleteSectionServerSide,
  getCourseTree,
} from "@/lib/server/community-classroom-service";
import type { CommunityGroup } from "@/types/community";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str, textToBodyHtml } from "./helpers";
import { oneLine } from "./text-safety";
import { bodyOnCard, bodyText, safeVideoUrl, titleProblem } from "./community-classroom-text";

/**
 * Community classroom tools (UPSTREAM_PORT_PLAN.md, N2a). list_communities
 * is a read for chat and API agents; add_course and add_lesson are chat-only
 * admin writes behind a confirm card, as the classroom's staff routes are
 * admin-only. All three refuse while the agency's Community gate is off.
 * The card names the group / course the model looked up, and execute
 * refuses when the id is another one's (the card must describe the write).
 */

const GROUPS_CAP = 20;
const COURSES_CAP = 30;
const DESCRIPTION_MAX = 2000;
const TEXT_MAX = 20000;

async function assertCommunityOn(subAccountId: string): Promise<void> {
  const sub = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data();
  if (sub?.communityEnabledByAgency !== true) {
    throw new CapabilityUserError(
      "Community & Courses is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
    );
  }
}

/** The group, in this workspace, carrying the name the card showed. */
async function namedGroup(subAccountId: string, groupId: string, groupName: string): Promise<CommunityGroup> {
  const group = await getGroupById(subAccountId, groupId);
  if (!group) throw new CapabilityUserError("That community group wasn't found in this workspace.");
  if (oneLine(group.name) !== groupName) {
    throw new CapabilityUserError(`That group id is “${oneLine(group.name)}”, not “${groupName}”; nothing was changed. Check list_communities.`);
  }
  return group;
}

const optionalBool = (raw: unknown, key: string): boolean | null => {
  const v = (raw as Record<string, unknown> | null)?.[key];
  return typeof v === "boolean" ? v : null;
};

export const COMMUNITY_CLASSROOM_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_communities",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "See your community groups and the courses in each",
    description:
      "List this workspace's community groups (name, status, mode, slug, group id) and the courses inside each (title, published or not, course id). Use it to answer 'what communities / courses do we have?' and to find the group and course ids add_course / add_lesson need.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List communities and courses.",
    execute: async (ctx) => {
      await assertCommunityOn(ctx.subAccountId!);
      const db = getAdminDb();
      const groupsSnap = await db.collection(`subAccounts/${ctx.subAccountId!}/communityGroups`).limit(GROUPS_CAP).get();
      if (groupsSnap.empty) return { resultText: "No community groups yet. Create one under Sidebar → Community." };
      const blocks: string[] = [];
      let coursesCapped = false;
      for (const g of groupsSnap.docs) {
        const data = g.data();
        const coursesSnap = await db
          .collection(`subAccounts/${ctx.subAccountId!}/communityGroups/${g.id}/courses`)
          .limit(COURSES_CAP)
          .get();
        if (coursesSnap.size >= COURSES_CAP) coursesCapped = true;
        const courses = coursesSnap.docs
          .map((c) => ({
            id: c.id,
            title: oneLine(c.data().title) || "(untitled)",
            published: c.data().published === true,
            order: typeof c.data().order === "number" ? (c.data().order as number) : 0,
          }))
          .sort((a, b) => a.order - b.order);
        const courseLines = courses.length
          ? courses.map((c) => `    • ${c.title}${c.published ? "" : " (unpublished)"} — course id: ${c.id}`).join("\n")
          : "    (no courses yet)";
        blocks.push(
          `- ${oneLine(data.name) || "(unnamed)"} — ${oneLine(data.status) || "draft"}, ${data.mode === "courses" ? "courses only" : "full community"}, slug: ${oneLine(data.slug) || "?"}, group id: ${g.id}\n${courseLines}`
        );
      }
      return {
        resultText: `Communities (${groupsSnap.size}):\n${blocks.join("\n")}`,
        ...(groupsSnap.size >= GROUPS_CAP || coursesCapped ? { truncated: true as const } : {}),
      };
    },
  },
  {
    name: "add_course",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel: "Add a course to an existing community",
    description:
      "Create a new course inside one of this workspace's community groups, open to all the group's members. Find the group's id and exact name with list_communities first. Published unless told otherwise; add lessons afterwards with add_lesson.",
    parameters: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "The community group's id, from list_communities." },
        groupName: { type: "string", description: "The group's name exactly as list_communities shows it — shown on the card and checked against the id." },
        title: { type: "string", description: "Course title." },
        description: { type: "string", description: "Optional one-paragraph description." },
        published: { type: "boolean", description: "Publish immediately (default true). false keeps it hidden from members." },
      },
      required: ["groupId", "groupName", "title"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const groupId = str(raw, "groupId");
      if (!isDocId(groupId)) return { ok: false, error: "the group id is required — look it up with list_communities first" };
      const groupName = str(raw, "groupName");
      const title = str(raw, "title");
      const bad = titleProblem("the group's name", groupName) ?? titleProblem("a course title", title);
      if (bad) return { ok: false, error: bad };
      const description = bodyText(raw, "description", "the description", DESCRIPTION_MAX);
      if ("error" in description) return { ok: false, error: description.error };
      return {
        ok: true,
        args: { groupId, groupName, title, description: description.text, published: optionalBool(raw, "published") ?? true },
      };
    },
    summarize: (args) =>
      `Add the course “${args.title}” to the community “${args.groupName}” (id ${args.groupId})${
        args.published ? " — published, open to all its members." : " as an unpublished draft."
      }${bodyOnCard("Description", args.description as string)}`,
    execute: async (ctx, args) => {
      await assertCommunityOn(ctx.subAccountId!);
      const group = await namedGroup(ctx.subAccountId!, args.groupId as string, args.groupName as string);
      const course = await createCourseServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        groupId: group.id,
        title: args.title as string,
        description: (args.description as string) || undefined,
        published: args.published as boolean,
      });
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      return {
        resultText: `Added the course “${oneLine(course.title)}” (id: ${course.id}) to “${oneLine(group.name)}”${
          args.published ? "" : " as an unpublished draft"
        }. Classroom: ${base}/c/${ctx.subAccountId}/${group.slug}/classroom/${course.id} — add lessons with add_lesson or in the classroom editor.`,
        ref: { kind: "course", id: course.id },
      };
    },
  },
  {
    name: "add_lesson",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel: "Add a lesson (with an optional video) to a course",
    description:
      "Add a lesson to an existing course in a community group, optionally under a named section (created if it doesn't exist), with an optional YouTube or Vimeo https link and plain-text body. Find the group and course ids and exact names with list_communities first. Published unless told otherwise.",
    parameters: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "Group id from list_communities." },
        courseId: { type: "string", description: "Course id from list_communities." },
        courseTitle: { type: "string", description: "The course's title exactly as list_communities shows it — shown on the card and checked against the id." },
        title: { type: "string", description: "Lesson title." },
        sectionTitle: { type: "string", description: "Optional section to file it under (matched by name; created if missing)." },
        videoUrl: { type: "string", description: "Optional YouTube or Vimeo https URL." },
        text: { type: "string", description: "Optional lesson text (plain text; paragraphs on blank lines)." },
        published: { type: "boolean", description: "Publish immediately (default true)." },
      },
      required: ["groupId", "courseId", "courseTitle", "title"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const groupId = str(raw, "groupId");
      const courseId = str(raw, "courseId");
      if (!isDocId(groupId) || !isDocId(courseId)) {
        return { ok: false, error: "the group id and course id are required — look them up with list_communities first" };
      }
      const courseTitle = str(raw, "courseTitle");
      const title = str(raw, "title");
      const sectionTitle = str(raw, "sectionTitle");
      const bad =
        titleProblem("the course's title", courseTitle) ??
        titleProblem("a lesson title", title) ??
        (sectionTitle ? titleProblem("the section title", sectionTitle.slice(0, 80)) : null);
      if (bad) return { ok: false, error: bad };
      const rawVideo = str(raw, "videoUrl");
      const videoUrl = rawVideo ? safeVideoUrl(rawVideo) : "";
      if (videoUrl === null) return { ok: false, error: "the video must be a YouTube or Vimeo https:// link" };
      const text = bodyText(raw, "text", "the lesson text", TEXT_MAX);
      if ("error" in text) return { ok: false, error: text.error };
      return {
        ok: true,
        args: {
          groupId,
          courseId,
          courseTitle,
          title,
          sectionTitle: sectionTitle.slice(0, 80),
          videoUrl,
          text: text.text,
          published: optionalBool(raw, "published") ?? true,
        },
      };
    },
    summarize: (args) =>
      `Add the lesson “${args.title}”${
        args.sectionTitle ? ` (section “${args.sectionTitle}”, created if missing)` : " (no section given: into the course's section if it has exactly one, otherwise unsectioned)"
      }${args.videoUrl ? ` with the video ${args.videoUrl}` : ""} to the course “${args.courseTitle}” (id ${args.courseId})${
        args.published ? " — published." : " as a draft."
      }${bodyOnCard("Text", args.text as string)}`,
    execute: async (ctx, args) => {
      await assertCommunityOn(ctx.subAccountId!);
      const group = await getGroupById(ctx.subAccountId!, args.groupId as string);
      if (!group) throw new CapabilityUserError("That community group wasn't found in this workspace.");
      const tree = await getCourseTree({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: args.courseId as string,
        includeUnpublished: true,
      });
      if (!tree) throw new CapabilityUserError("That course wasn't found in this community.");
      if (oneLine(tree.course.title) !== args.courseTitle) {
        throw new CapabilityUserError(`That course id is “${oneLine(tree.course.title)}”, not “${args.courseTitle}”; nothing was changed. Check list_communities.`);
      }
      let sectionId: string | null = null;
      let createdSectionId: string | null = null;
      let sectionNote = "";
      const wantSection = args.sectionTitle as string;
      if (wantSection) {
        const match = tree.sections.find((s) => s.title.trim().toLowerCase() === wantSection.toLowerCase());
        if (match) {
          sectionId = match.id;
        } else {
          const created = await createSectionServerSide({
            subAccountId: ctx.subAccountId!,
            groupId: group.id,
            courseId: tree.course.id,
            title: wantSection,
          });
          sectionId = createdSectionId = created.id;
          sectionNote = ` (new section “${created.title}” created)`;
        }
      } else if (tree.sections.length === 1) {
        sectionId = tree.sections[0]!.id;
        sectionNote = ` (in its section “${oneLine(tree.sections[0]!.title)}”)`;
      }
      // One write: the lesson never exists half-made.
      let lesson;
      try {
        lesson = await createLessonServerSide({
          subAccountId: ctx.subAccountId!,
          groupId: group.id,
          courseId: tree.course.id,
          sectionId,
          title: args.title as string,
          published: args.published as boolean,
          videoUrl: (args.videoUrl as string) || null,
          bodyHtml: args.text ? textToBodyHtml(args.text as string) : "",
        });
      } catch (err) {
        // Don't leave behind an empty section this call made for it.
        if (createdSectionId) {
          await deleteSectionServerSide({ subAccountId: ctx.subAccountId!, groupId: group.id, courseId: tree.course.id, sectionId: createdSectionId }).catch(
            (cleanupErr: unknown) => console.warn(`[ai-suite/add_lesson] empty section ${createdSectionId} left behind: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
          );
        }
        throw err;
      }
      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      return {
        resultText: `Added the lesson “${oneLine(lesson.title)}” to “${oneLine(tree.course.title)}”${sectionNote}${
          args.published ? "" : " as an unpublished draft"
        }. ${base}/c/${ctx.subAccountId}/${group.slug}/classroom/${tree.course.id}/${lesson.id}`,
        ref: { kind: "lesson", id: lesson.id },
      };
    },
  },
];
