/**
 * Proof harness for the appointments listener bound (subscribeToAppointments
 * in src/lib/firestore/events.ts). Seeds past events on the E2E PRIMARY
 * fixture sub-account, then times, through the Firebase client SDK the page
 * uses, signed in as the E2E user:
 *   - first snapshot: subscribe → first delivery (what "Loading…" waits on)
 *   - write → delivery: an Admin-SDK status write to one future probe event
 *     (the mark-status route's path) → the listener seeing it
 * for the old unbounded query and the new bounded pair. Seeded docs are
 * deleted afterwards, also when a step throws.
 *
 * Run with Node 22:
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/events-listener-timing.ts --project <firebase-project-id> \
 *     [--seed 2000] [--trials 5] [--past-asc]
 *
 * Refuses to run unless E2E_SUBACCOUNT_ID is named "E2E Fixture Primary" and
 * belongs to E2E_AGENCY_ID. Seeded titles start "E2E Perf <run> ", so
 * e2e/lib/reap-events.ts also removes anything a killed run leaves behind.
 * The query shapes below mirror subscribeToAppointments; its unit test pins
 * those constraints. `--past-asc` orders the past half ascending: the same
 * 200-doc listener, for measuring before the (subAccountId, startAt DESC)
 * index is deployed — Firestore rejects the real shape until it is.
 */
import { cert, initializeApp as initAdmin } from "firebase-admin/app";
import { getFirestore as getAdminDb, type Firestore as AdminDb } from "firebase-admin/firestore";
import { deleteApp, initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
  type Query,
} from "firebase/firestore";

const E = process.env;
const DAY = 86_400_000;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

function need(name: string): string {
  const v = E[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

async function assertFixture(db: AdminDb, saId: string): Promise<void> {
  const sa = (await db.doc(`subAccounts/${saId}`).get()).data();
  if (sa?.name !== "E2E Fixture Primary" || sa?.agencyId !== need("E2E_AGENCY_ID")) {
    throw new Error(`${saId} is not the E2E primary fixture. Refusing to run.`);
  }
}

async function seed(db: AdminDb, saId: string, prefix: string, n: number): Promise<string> {
  const statuses = ["completed", "cancelled", "no_show", "scheduled"];
  const base = {
    agencyId: need("E2E_AGENCY_ID"),
    subAccountId: saId,
    createdByUid: "e2e",
    contactId: null,
    location: "",
    notes: "",
    source: "booking_page",
    territoryId: "global",
    // Hosted, never "shared busy": a hostless event would block every
    // hostless booking page's slots for the specs running meanwhile.
    hostUids: ["e2e-perf-host"],
    assignedToUid: "e2e-perf-host",
    assignedToName: "E2E Perf Host",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  for (let i = 0; i < n; i += 400) {
    const batch = db.batch();
    for (let j = i; j < Math.min(n, i + 400); j++) {
      const start = Date.now() - (1 + (j % 365)) * DAY;
      batch.set(db.collection("events").doc(), {
        ...base,
        title: `${prefix}${j}`,
        status: statuses[j % statuses.length],
        startAt: new Date(start),
        endAt: new Date(start + 30 * 60_000),
      });
    }
    await batch.commit();
  }
  // The probe: in the future (so it is in the bounded upcoming half, like the
  // spec's cancelled row), 30 days out — past every fixture page's 14-day
  // booking window.
  const probeStart = Date.now() + 30 * DAY;
  const probe = db.collection("events").doc();
  await probe.set({
    ...base,
    title: `${prefix}probe`,
    status: "scheduled",
    startAt: new Date(probeStart),
    endAt: new Date(probeStart + 30 * 60_000),
  });
  return probe.id;
}

async function cleanup(db: AdminDb, saId: string, prefix: string): Promise<number> {
  const snap = await db
    .collection("events")
    .where("title", ">=", prefix)
    .where("title", "<", prefix + "")
    .get();
  let n = 0;
  for (const d of snap.docs) {
    const e = d.data();
    if (e.subAccountId !== saId || e.agencyId !== need("E2E_AGENCY_ID")) {
      throw new Error(`${d.ref.path} is outside the fixture. Refusing to delete it.`);
    }
    await d.ref.delete();
    n++;
  }
  return n;
}

type Shape = "unbounded" | "bounded";
const PAST_ORDER = process.argv.includes("--past-asc") ? "asc" : "desc";

function queries(shape: Shape, fs: ReturnType<typeof getFirestore>, saId: string): Query[] {
  const col = collection(fs, "events");
  const sa = where("subAccountId", "==", saId);
  if (shape === "unbounded") return [query(col, sa)];
  const boundary = Timestamp.fromMillis(Date.now());
  return [
    query(col, sa, where("startAt", ">=", boundary), orderBy("startAt", "asc"), limit(500)),
    query(col, sa, where("startAt", "<", boundary), orderBy("startAt", PAST_ORDER), limit(200)),
  ];
}

/** One fresh client app per shape, so neither run is served from the other's cache. */
async function measure(shape: Shape, db: AdminDb, saId: string, probeId: string, trials: number) {
  const app = initializeApp(
    {
      apiKey: need("NEXT_PUBLIC_FIREBASE_API_KEY"),
      authDomain: E.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: need("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
    },
    `timing-${shape}`,
  );
  try {
    await signInWithEmailAndPassword(getAuth(app), need("E2E_EMAIL"), need("E2E_PASSWORD"));
    const fs = getFirestore(app);
    let waiter: { status: string; resolve: () => void } | null = null;
    let firstPending = 0;
    let docs = 0;
    const t0 = performance.now();
    let firstDone: () => void = () => undefined;
    let fail: (err: Error) => void = () => undefined;
    const first = new Promise<void>((resolve, reject) => {
      firstDone = resolve;
      fail = reject;
    });
    const qs = queries(shape, fs, saId);
    firstPending = qs.length;
    const unsubs = qs.map((q) =>
      onSnapshot(q, (snap) => {
        if (firstPending > 0) {
          docs += snap.size;
          if (--firstPending === 0) firstDone();
        }
        const probe = snap.docs.find((d) => d.id === probeId);
        if (waiter && probe?.data().status === waiter.status) waiter.resolve();
      }, (err) => fail(err)),
    );
    await first;
    const firstMs = performance.now() - t0;
    const writes: number[] = [];
    for (let i = 0; i < trials; i++) {
      const status = i % 2 === 0 ? "cancelled" : "scheduled";
      const seen = new Promise<void>((resolve) => (waiter = { status, resolve }));
      const w0 = performance.now();
      await db.doc(`events/${probeId}`).update({ status, updatedAt: new Date() });
      await seen;
      writes.push(performance.now() - w0);
      waiter = null;
    }
    // Leave the probe as seeded for the next shape.
    await db.doc(`events/${probeId}`).update({ status: "scheduled" });
    unsubs.forEach((u) => u());
    const sorted = [...writes].sort((a, b) => a - b);
    return {
      shape,
      docsDelivered: docs,
      firstSnapshotMs: Math.round(firstMs),
      writeToDeliveryMs: writes.map(Math.round),
      writeMedianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    };
  } finally {
    await deleteApp(app);
  }
}

async function main(): Promise<void> {
  const project = process.argv[process.argv.indexOf("--project") + 1];
  if (!process.argv.includes("--project") || project !== need("FIREBASE_ADMIN_PROJECT_ID")) {
    throw new Error("--project must match FIREBASE_ADMIN_PROJECT_ID");
  }
  const n = arg("--seed", 2000);
  const trials = arg("--trials", 5);
  initAdmin({
    credential: cert({
      projectId: project,
      clientEmail: need("FIREBASE_ADMIN_CLIENT_EMAIL"),
      privateKey: need("FIREBASE_ADMIN_PRIVATE_KEY").replace(/\\n/g, "\n"),
    }),
  });
  const db = getAdminDb();
  const saId = need("E2E_SUBACCOUNT_ID");
  await assertFixture(db, saId);
  const prefix = `E2E Perf ${Date.now().toString(36)} `;
  try {
    const probeId = await seed(db, saId, prefix, n);
    const results = [];
    // Twice each, alternating, so a warm-up effect cannot favour one shape.
    for (const shape of ["unbounded", "bounded", "unbounded", "bounded"] as const) {
      results.push(await measure(shape, db, saId, probeId, trials));
    }
    console.log(JSON.stringify({ seeded: n, pastOrder: PAST_ORDER, results }, null, 2));
  } finally {
    console.log(JSON.stringify({ cleanedUp: await cleanup(db, saId, prefix) }));
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
