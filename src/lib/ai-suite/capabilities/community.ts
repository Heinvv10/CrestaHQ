import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createGroupServerSide } from "@/lib/server/community-service";
import {
  createCourseServerSide,
  createLessonServerSide,
  createSectionServerSide,
  updateLessonServerSide,
} from "@/lib/server/community-classroom-service";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str, textToBodyHtml } from "./helpers";

export const COMMUNITY_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "create_community",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Set up a new community with its first course and lesson (returns the live URLs)",
    description:
      "Set up a new community (a Skool-style group with a feed + classroom) in this sub-account, including its first course and first lesson, and return the live URLs. Gather conversationally before calling: the community's name, who can join (open, or approval-required), an optional one-line tagline, the first lesson's title, and optionally a YouTube/Vimeo video URL and/or lesson text. Everything is created PUBLISHED and live on confirm. Free-to-join communities only — for a paid community, point the user at Sidebar → Community (pricing needs PayPal setup).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The community's name." },
        tagline: {
          type: "string",
          description: "Optional one-line tagline shown on the community card.",
        },
        about: {
          type: "string",
          description: "Optional longer description for the About panel.",
        },
        joinPolicy: {
          type: "string",
          enum: ["open", "approval"],
          description:
            "'open' = anyone with the link joins instantly (default); 'approval' = join requests need admin approval.",
        },
        courseTitle: {
          type: "string",
          description:
            "Optional first-course title. Defaults to 'Getting started'.",
        },
        lessonTitle: {
          type: "string",
          description: "The first lesson's title.",
        },
        lessonVideoUrl: {
          type: "string",
          description: "Optional YouTube or Vimeo URL for the first lesson.",
        },
        lessonText: {
          type: "string",
          description:
            "Optional written content for the first lesson (plain text).",
        },
      },
      required: ["name", "lessonTitle"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name)
        return { ok: false, error: "a name for the community is required" };
      const lessonTitle = str(raw, "lessonTitle");
      if (!lessonTitle) {
        return { ok: false, error: "a title for the first lesson is required" };
      }
      const joinPolicy = str(raw, "joinPolicy") || "open";
      if (joinPolicy !== "open" && joinPolicy !== "approval") {
        return {
          ok: false,
          error: "the join policy must be 'open' or 'approval'",
        };
      }
      return {
        ok: true,
        args: {
          name,
          tagline: str(raw, "tagline"),
          about: str(raw, "about"),
          joinPolicy,
          courseTitle: str(raw, "courseTitle") || "Getting started",
          lessonTitle,
          lessonVideoUrl: str(raw, "lessonVideoUrl"),
          lessonText: str(raw, "lessonText").slice(0, 8000),
        },
      };
    },
    summarize: (args) =>
      `Create the community “${args.name}” (${
        args.joinPolicy === "approval"
          ? "join requests need approval"
          : "open to join"
      }, free) with a published “${args.courseTitle}” course and first lesson “${
        args.lessonTitle
      }”${args.lessonVideoUrl ? " (with video)" : ""} — live immediately.`,
    execute: async (ctx, args) => {
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.communityEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Community & Courses is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // Group → course → section → lesson, all published so the URLs work
      // the moment the user clicks them.
      const group = await createGroupServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        name: args.name as string,
        tagline: (args.tagline as string) || undefined,
        about: (args.about as string) || undefined,
        access: "free",
        joinPolicy: args.joinPolicy as "open" | "approval",
        status: "published",
      });
      const course = await createCourseServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        groupId: group.id,
        title: args.courseTitle as string,
        published: true,
      });
      const section = await createSectionServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        title: "Getting started",
      });
      const lesson = await createLessonServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        sectionId: section.id,
        title: args.lessonTitle as string,
      });
      const { videoError } = await updateLessonServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        lessonId: lesson.id,
        patch: {
          published: true,
          videoUrl: (args.lessonVideoUrl as string) || null,
          bodyHtml: args.lessonText
            ? textToBodyHtml(args.lessonText as string)
            : "",
        },
      });

      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const communityUrl = `${base}/c/${ctx.subAccountId}/${group.slug}/community`;
      const lessonUrl = `${base}/c/${ctx.subAccountId}/${group.slug}/classroom/${course.id}/${lesson.id}`;
      const videoNote = videoError
        ? " (⚠️ the video URL wasn't recognized — YouTube/Vimeo links only; add it in the classroom editor)"
        : args.lessonVideoUrl
          ? " with video"
          : "";
      return {
        resultText: `Your community “${group.name}” is live.\nCommunity feed: ${communityUrl}\nFirst lesson “${lesson.title}”${videoNote}: ${lessonUrl}\nMembers sign in via a magic link (tied to their contact record) — share the community URL to invite them${
          args.joinPolicy === "approval"
            ? "; join requests will wait for your approval"
            : ""
        }. Manage everything under Sidebar → Community.`,
        ref: { kind: "communityGroup", id: group.id },
      };
    },
  },
];
