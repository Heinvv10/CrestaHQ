import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, doConfirm, lookupResult, mem, role, seedTenants } from "@/test/chat-route-harness";

/**
 * list_communities, add_course and add_lesson (N2a) through the real chat
 * and confirm routes. Reads for members on both surfaces; the writes are
 * admin-only confirm cards, refused with the Community gate off, act only
 * in the caller's own sub-account, refuse a card naming another group or
 * course than the id, and store only YouTube / Vimeo https video links.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/chat-route-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/chat-route-harness")).tenancyMock());
vi.mock("@/lib/ai-suite/model", async () => (await import("@/test/chat-route-harness")).modelMock());
vi.mock("@/lib/ai-suite/usage", () => ({ recordAiSuiteUsage: async () => undefined }));
vi.mock("@/lib/ai-suite/audit", () => ({ recordAiSuiteAction: async () => undefined }));
const lessonWrite = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/server/community-classroom-service", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/server/community-classroom-service");
  return {
    ...real,
    createLessonServerSide: async (opts: Parameters<typeof real.createLessonServerSide>[0]) => {
      if (lessonWrite.fail) throw new Error("lesson write failed");
      return real.createLessonServerSide(opts);
    },
  };
});

const { availableOn, getCapability, toolsForLevel } = await import("@/lib/ai-suite/capabilities");

const G1 = "subAccounts/sa1/communityGroups/g1";
const THEIRS = "subAccounts/sa2/communityGroups/gB";
const COURSE = { title: "Basics", published: true, order: 0, subAccountId: "sa1", agencyId: "ag1", groupId: "g1" };
const COURSE_ARGS = { groupId: "g1", groupName: "Fibre Club", title: "Install 101" };
const LESSON_ARGS = { groupId: "g1", courseId: "co1", courseTitle: "Basics", title: "Welcome" };
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const courses = (group = G1) => mem.list(`${group}/courses`);
const lessons = () => mem.list(`${G1}/courses/co1/lessons`);

beforeEach(() => {
  seedTenants({ communityEnabledByAgency: true });
  lessonWrite.fail = false;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.test");
  mem.seed(G1, { name: "Fibre Club", slug: "fibre-club", status: "published", subAccountId: "sa1", agencyId: "ag1" });
  mem.seed(`${G1}/courses/co1`, COURSE);
  mem.seed(THEIRS, { name: "Their Club", slug: "their-club", status: "published", subAccountId: "sa2", agencyId: "ag1" });
  mem.seed(`${THEIRS}/courses/coB`, { ...COURSE, title: "Their course", subAccountId: "sa2", groupId: "gB" });
});
afterEach(() => vi.unstubAllEnvs());

describe("list_communities", () => {
  it("a collaborator runs it in chat and sees only this workspace's groups and courses, with their ids", async () => {
    role.current = "collaborator";
    await ask("list_communities", {});
    const text = lookupResult();
    expect(text).toContain("- Fibre Club — published, full community, slug: fibre-club, group id: g1");
    expect(text).toContain("    • Basics — course id: co1");
    expect(text).not.toContain("Their");
    expect(availableOn(getCapability("list_communities")!, "agent")).toBe(true);
  });

  it("a group at the course cap marks the answer truncated", async () => {
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1", subAccountRole: "admin" };
    const list = getCapability("list_communities")!;
    expect((await list.execute(ctx, {})).truncated).toBeUndefined();
    for (let i = 1; i < 30; i++) mem.seed(`${G1}/courses/co_${i}`, { ...COURSE, title: `C${i}`, order: i });
    expect((await list.execute(ctx, {})).truncated).toBe(true);
  });

  it("is refused with the Community gate off", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, communityEnabledByAgency: false });
    await ask("list_communities", {});
    expect(lookupResult()).toContain("The lookup couldn't run: Community & Courses is disabled for this workspace.");
  });
});

describe("add_course", () => {
  it("an admin gets a card naming the group and its id; the course is created in it only on confirm", async () => {
    const body = await (await ask("add_course", COURSE_ARGS)).json();
    expect(body.proposal.summary).toBe("Add the course “Install 101” to the community “Fibre Club” (id g1) — published, open to all its members.");
    expect(courses()).toHaveLength(1);
    const res = await doConfirm("add_course", body.proposal.args);
    expect(res.status).toBe(200);
    expect((await res.json()).resultText).toContain("https://crm.example.test/c/sa1/fibre-club/classroom/");
    expect(courses().map((c) => c.title).sort()).toEqual(["Basics", "Install 101"]);
    expect(courses().find((c) => c.title === "Install 101")).toMatchObject({ published: true, access: "open", subAccountId: "sa1", agencyId: "ag1" });
  });

  it("the card quotes the description and lists every link in it; the stored description is the one shown", async () => {
    const description = `Start here.\n\nLog in at https://evil.example/login before the ${"x".repeat(300)} end, or www.other.example`;
    // Stored as shown: a no-break space and trailing line spaces are normalised first.
    const sent = description.replace("Start here.", "Start\u00a0here.  ");
    const body = await (await ask("add_course", { ...COURSE_ARGS, description: sent })).json();
    const summary = body.proposal.summary as string;
    expect(summary).toContain(
      `Description (${description.length} characters): “Start here. Log in at https://evil.example/login before the ${"x".repeat(300)} end, or www.other.example”. Links in it: https://evil.example/login, www.other.example.`
    );
    expect((await doConfirm("add_course", body.proposal.args)).status).toBe(200);
    expect(courses().find((c) => c.title === "Install 101")!.description).toBe(description);
  });

  it("the card shows ALL the description, however far in the payment details sit", async () => {
    const tail = "Renewal: pay R499 into FNB 62812345678 ref MEMBER, or go to evil-pay.example/renew or call 0861 000 111.";
    const description = `${"Welcome to the club. ".repeat(16)}${"y".repeat(345 - 21 * 16)}${tail}`;
    const body = await (await ask("add_course", { ...COURSE_ARGS, description })).json();
    expect(body.proposal.summary).toContain(`Description (${description.length} characters): “${description}”.`);
  });

  it("a link whose host uses look-alike letters or punycode is flagged on the card; a plain one is not", async () => {
    const description = "Pay at https://p\u0430ypal.example/x or https://xn--pypal-4ve.example or https://pay-pal.example/ok";
    const body = await (await ask("add_course", { ...COURSE_ARGS, description })).json();
    expect(body.proposal.summary).toContain(
      "Links in it: https://p\u0430ypal.example/x (CAUTION: its address mixes Latin with Cyrillic or Greek letters in one word), " +
        "https://xn--pypal-4ve.example (CAUTION: its address is punycode for a non-Latin address), https://pay-pal.example/ok."
    );
  });

  it.each([
    ["another workspace's group id", { ...COURSE_ARGS, groupId: "gB", groupName: "Their Club" }, "wasn't found in this workspace"],
    ["a card naming another group than the id", { ...COURSE_ARGS, groupName: "Gym Club" }, "That group id is “Fibre Club”, not “Gym Club”"],
  ])("%s: refused, nothing written", async (_what, args, error) => {
    const before = JSON.stringify(mem.all());
    const res = await doConfirm("add_course", args);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(error);
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each([
    ["a path for the group id", { ...COURSE_ARGS, groupId: "g1/courses/co1" }],
    ["no group name", { ...COURSE_ARGS, groupName: "" }],
    ["a hidden character in the title", { ...COURSE_ARGS, title: "Install‮101" }],
    ["an oversized title", { ...COURSE_ARGS, title: "x".repeat(201) }],
    ["a bidi override in the description", { ...COURSE_ARGS, description: "Pay at evil.example\u202Etxt.exe" }],
    ["an invisible character in the description", { ...COURSE_ARGS, description: "Free\u200b course" }],
    ["an oversized description", { ...COURSE_ARGS, description: "x".repeat(2001) }],
  ])("%s: invalid, nothing written", async (_what, args) => {
    const before = JSON.stringify(mem.all());
    const res = await doConfirm("add_course", args);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Can't run that action: /);
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("the Community gate off: refused, nothing written", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, communityEnabledByAgency: false });
    const res = await doConfirm("add_course", COURSE_ARGS);
    expect((await res.json()).error).toContain("Community & Courses is disabled");
    expect(courses()).toHaveLength(1);
  });

  it("a collaborator is not offered the writes; the confirm route refuses with 403", async () => {
    role.current = "collaborator";
    const tools = toolsForLevel("sub-account", { agencyRoleIsOwner: false, subAccountRole: "collaborator" }).map((t) => t.function.name);
    expect(tools).toContain("list_communities");
    expect(tools).not.toContain("add_course");
    expect(tools).not.toContain("add_lesson");
    expect((await doConfirm("add_course", COURSE_ARGS)).status).toBe(403);
    expect((await doConfirm("add_lesson", LESSON_ARGS)).status).toBe(403);
    expect(courses()).toHaveLength(1);
    expect(lessons()).toHaveLength(0);
  });

  it("neither write is offered to API agents", () => {
    for (const name of ["add_course", "add_lesson"]) expect(availableOn(getCapability(name)!, "agent")).toBe(false);
  });
});

describe("add_lesson", () => {
  it("creates a published lesson with the video and escaped text, in a new section, on confirm", async () => {
    const args = { ...LESSON_ARGS, sectionTitle: "Start here", videoUrl: VIDEO, text: "Hi <b>there</b>\n\nSecond" };
    const body = await (await ask("add_lesson", args)).json();
    expect(body.proposal.summary).toBe(`Add the lesson “Welcome” (section “Start here”, created if missing) with the video ${VIDEO} to the course “Basics” (id co1) — published. Text (23 characters): “Hi <b>there</b> Second”.`);
    expect(lessons()).toHaveLength(0);
    expect((await doConfirm("add_lesson", body.proposal.args)).status).toBe(200);
    const [lesson] = lessons();
    expect(lesson).toMatchObject({
      title: "Welcome", published: true, videoUrl: VIDEO, videoProvider: "youtube", videoId: "dQw4w9WgXcQ",
      bodyHtml: "<p>Hi &lt;b&gt;there&lt;/b&gt;</p><p>Second</p>",
    });
    const [section] = mem.list(`${G1}/courses/co1/sections`);
    expect(section).toMatchObject({ title: "Start here" });
    expect(lesson!.sectionId).toBe(section!.id);
  });

  it("the card quotes the lesson text with its links, and says where a lesson with no section goes; it lands in the only section", async () => {
    mem.seed(`${G1}/courses/co1/sections/s1`, { title: "Intro", order: 0 });
    const text = "Read https://evil.example/a first.";
    const body = await (await ask("add_lesson", { ...LESSON_ARGS, text })).json();
    expect(body.proposal.summary).toBe(
      "Add the lesson “Welcome” (no section given: into the course's section if it has exactly one, otherwise unsectioned) to the course “Basics” (id co1) — published." +
        ` Text (${text.length} characters): “${text}”. Links in it: https://evil.example/a.`
    );
    const res = await doConfirm("add_lesson", body.proposal.args);
    expect((await res.json()).resultText).toContain("(in its section “Intro”)");
    expect(lessons()[0]).toMatchObject({ sectionId: "s1", bodyHtml: "<p>Read https://evil.example/a first.</p>" });
  });

  it.each([
    ["a bidi override", "Click here\u202Eexe.pdf"],
    ["an invisible character", "Join\u2060 now"],
    ["oversized text", "x".repeat(20001)],
  ])("lesson text with %s: invalid, nothing written", async (_what, text) => {
    const before = JSON.stringify(mem.all());
    const res = await doConfirm("add_lesson", { ...LESSON_ARGS, text });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Can't run that action: the lesson text /);
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("the lesson write fails: no lesson, and the section made for it is removed", async () => {
    lessonWrite.fail = true;
    const before = JSON.stringify(mem.all());
    const res = await doConfirm("add_lesson", { ...LESSON_ARGS, sectionTitle: "New one" });
    expect(res.status).not.toBe(200);
    expect(lessons()).toHaveLength(0);
    expect(mem.list(`${G1}/courses/co1/sections`)).toHaveLength(0);
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each([
    ["javascript: with a YouTube id in it", "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ"],
    ["http", "http://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["a host that only mentions YouTube", "https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ"],
    ["credentials in the URL", "https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["a YouTube page with no video id", "https://www.youtube.com/channel/abc"],
  ])("a video link that is %s: invalid, nothing written", async (_what, videoUrl) => {
    const before = JSON.stringify(mem.all());
    const res = await doConfirm("add_lesson", { ...LESSON_ARGS, videoUrl });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("YouTube or Vimeo https://");
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it.each([
    ["another workspace's group and course", { ...LESSON_ARGS, groupId: "gB", courseId: "coB", courseTitle: "Their course" }, "group wasn't found in this workspace"],
    ["a course in another group than the id's", { ...LESSON_ARGS, courseId: "coB", courseTitle: "Their course" }, "course wasn't found in this community"],
    ["a card naming another course than the id", { ...LESSON_ARGS, courseTitle: "Advanced" }, "That course id is “Basics”, not “Advanced”"],
  ])("%s: refused, nothing written", async (_what, args, error) => {
    const before = JSON.stringify(mem.all());
    const res = await doConfirm("add_lesson", args);
    expect((await res.json()).error).toContain(error);
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("a path for the course id: invalid, nothing written", async () => {
    const before = JSON.stringify(mem.all());
    const res = await doConfirm("add_lesson", { ...LESSON_ARGS, courseId: "co1/lessons/x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("look them up with list_communities first");
    expect(JSON.stringify(mem.all())).toBe(before);
  });

  it("the Community gate off: refused, nothing written", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, communityEnabledByAgency: false });
    const res = await doConfirm("add_lesson", LESSON_ARGS);
    expect((await res.json()).error).toContain("Community & Courses is disabled");
    expect(lessons()).toHaveLength(0);
  });
});
