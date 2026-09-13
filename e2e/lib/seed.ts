import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./admin";
import { readEnv } from "./env";

/**
 * Fixture data the specs read. Idempotent: every helper is find-or-create, so
 * a rerun after a crashed teardown reuses what is already there instead of
 * piling up duplicates.
 *
 * Shapes mirror what the app itself writes (src/types/forms.ts,
 * src/types/workflows.ts, the create paths in src/lib/server) — a fixture
 * that diverges from the real shape tests the fixture, not the app.
 */

export const FIXTURE_FORM_SLUG = "e2e-fixture-form";
export const FIXTURE_WORKFLOW_NAME = "E2E fixture — tag on form submit";
/** Applied by the workflow's first node; the enrol spec asserts on it. */
export const FIXTURE_TAG = "e2e-workflow-tagged";
export const MARKER_PRIMARY_NAME = "E2E Marker Primary";
export const MARKER_SECONDARY_NAME = "E2E Marker Secondary";

export interface SeedResult {
  formId: string;
  workflowId: string;
  /** Entry node of the fixture workflow — the `add_tag` step. */
  addTagNodeId: string;
}

const ADD_TAG_NODE_ID = "e2e-add-tag";

export async function ownerUid(agencyId: string): Promise<string> {
  const snap = await adminDb().doc(`agencies/${agencyId}`).get();
  const uid = snap.data()?.ownerUid;
  if (typeof uid !== "string" || !uid) {
    throw new Error(`Agency ${agencyId} has no ownerUid.`);
  }
  return uid;
}

async function ensureForm(
  agencyId: string,
  subAccountId: string,
  createdByUid: string,
): Promise<string> {
  const db = adminDb();
  const existing = await db
    .collection("forms")
    .where("subAccountId", "==", subAccountId)
    .where("slug", "==", FIXTURE_FORM_SLUG)
    .limit(1)
    .get();
  if (!existing.empty) return existing.docs[0].id;

  const ref = await db.collection("forms").add({
    name: "E2E fixture form",
    slug: FIXTURE_FORM_SLUG,
    fields: [
      {
        id: "name",
        type: "text",
        label: "Full name",
        placeholder: "Jane Doe",
        required: true,
        options: [],
        mapsTo: "name",
      },
      {
        id: "email",
        type: "email",
        label: "Email",
        placeholder: "jane@example.com",
        required: true,
        options: [],
        mapsTo: "email",
      },
    ],
    settings: {
      pipelineStageId: "new",
      autoTags: ["e2e"],
      thankYouMessage: "Thanks — we'll be in touch shortly.",
      redirectUrl: "",
      createDeal: false,
      dealTitleTemplate: "New lead — {name}",
      dealValue: 0,
      dealCurrency: "USD",
      appearance: {
        theme: "light",
        accent: "#7c3aed",
        hideChrome: false,
        hideTitle: false,
      },
    },
    agencyId,
    subAccountId,
    createdByUid,
    enabled: true,
    submissionCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function ensureWorkflow(
  agencyId: string,
  subAccountId: string,
  createdByUid: string,
  formId: string,
): Promise<string> {
  const db = adminDb();
  const nodes = {
    [ADD_TAG_NODE_ID]: {
      id: ADD_TAG_NODE_ID,
      type: "add_tag",
      config: { tag: FIXTURE_TAG },
      next: null,
    },
  };

  const existing = await db
    .collection("workflows")
    .where("subAccountId", "==", subAccountId)
    .where("name", "==", FIXTURE_WORKFLOW_NAME)
    .limit(1)
    .get();

  if (!existing.empty) {
    const ref = existing.docs[0].ref;
    // Re-point at the current form and re-activate. A workflow left paused
    // (or bound to a deleted form) makes the enrol spec fail for a reason
    // that has nothing to do with the code under test.
    await ref.update({
      status: "active",
      startNodeId: ADD_TAG_NODE_ID,
      nodes,
      "trigger.formId": formId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  }

  const ref = await db.collection("workflows").add({
    subAccountId,
    agencyId,
    createdByUid,
    name: FIXTURE_WORKFLOW_NAME,
    status: "active",
    trigger: {
      type: "form.submitted",
      filters: { all: [], match: "all" },
      formId,
    },
    reentry: "every_time",
    startNodeId: ADD_TAG_NODE_ID,
    nodes,
    stats: { enrolled: 0, completed: 0 },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/**
 * One contact per fixture sub-account, named distinctly. The switch spec
 * asserts each sub-account's page shows its own marker and NOT the other's —
 * which is scoping, rather than merely "a page rendered".
 */
async function ensureMarkerContact(
  agencyId: string,
  subAccountId: string,
  createdByUid: string,
  name: string,
): Promise<void> {
  const db = adminDb();
  const existing = await db
    .collection("contacts")
    .where("subAccountId", "==", subAccountId)
    .where("name", "==", name)
    .limit(1)
    .get();
  if (!existing.empty) return;

  await db.collection("contacts").add({
    name,
    email: "",
    phone: "",
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: ["e2e-marker"],
    pipelineStage: null,
    attribution: null,
    agencyId,
    subAccountId,
    createdByUid,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export const FIXTURE_BOOKING_SLUG = "e2e-fixture-booking";

/**
 * A published booking page wide open every day/hour so the availability
 * calculator always has a next slot, regardless of when the suite runs.
 * `redirectUrl` is passed in (rather than fixed) because the booking-widget
 * spec needs it to point at a same-run throwaway HTTP server — re-pointed
 * on every run the same way `ensureWorkflow` re-points its form binding.
 */
export async function ensureBookingPage(
  agencyId: string,
  subAccountId: string,
  createdByUid: string,
  redirectUrl: string,
): Promise<string> {
  const db = adminDb();
  const ref = db.doc(
    `subAccounts/${subAccountId}/bookingPages/${FIXTURE_BOOKING_SLUG}`,
  );
  const wideOpen = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek: dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6,
    startMinute: 0,
    endMinute: 1440,
  }));
  await ref.set({
    id: FIXTURE_BOOKING_SLUG,
    slug: FIXTURE_BOOKING_SLUG,
    name: "E2E fixture — 30 min booking",
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: wideOpen,
    timezone: "UTC",
    visibleDays: 14,
    minNoticeHours: 0,
    maxPerDay: null,
    intakeFields: [],
    hosts: [],
    allowHostSelection: false,
    logoUrl: null,
    accentColor: null,
    meetingUrl: null,
    confirmationMessage: "Thanks — see you then.",
    redirectUrl,
    redirectAppendParams: true,
    remindersEnabled: false,
    reminderOffsetsMinutes: [],
    payment: null,
    defaultTerritoryId: null,
    agencyId,
    subAccountId,
    createdByUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return FIXTURE_BOOKING_SLUG;
}

export async function ensureSeed(): Promise<SeedResult> {
  const env = readEnv();
  const agencyId = env.E2E_AGENCY_ID;
  const primary = env.E2E_SUBACCOUNT_ID;
  const secondary = env.E2E_SUBACCOUNT_ID_SECONDARY;

  const uid = await ownerUid(agencyId);
  const formId = await ensureForm(agencyId, primary, uid);
  const workflowId = await ensureWorkflow(agencyId, primary, uid, formId);
  await ensureMarkerContact(agencyId, primary, uid, MARKER_PRIMARY_NAME);
  await ensureMarkerContact(agencyId, secondary, uid, MARKER_SECONDARY_NAME);

  return { formId, workflowId, addTagNodeId: ADD_TAG_NODE_ID };
}
