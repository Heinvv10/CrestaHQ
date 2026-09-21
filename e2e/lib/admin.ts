import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { readEnv } from "./env";

/**
 * Firebase Admin handle for the suite. Separate from src/lib/firebase/admin.ts
 * because that module is `server-only` — importing it from a Playwright worker
 * would throw. Same credentials, same project.
 */

let _app: App | null = null;
let _db: Firestore | null = null;

function app(): App {
  if (_app) return _app;
  const existing = getApps().find((a) => a.name === "e2e");
  if (existing) {
    _app = existing;
    return _app;
  }
  const env = readEnv();
  _app = initializeApp(
    {
      credential: cert({
        projectId: env.FIREBASE_ADMIN_PROJECT_ID,
        clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
        privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY,
      }),
      storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    },
    "e2e",
  );
  return _app;
}

export function adminDb(): Firestore {
  if (_db) return _db;
  _db = getFirestore(app());
  _db.settings({ ignoreUndefinedProperties: true });
  return _db;
}

export function adminAuth(): Auth {
  return getAuth(app());
}

/** The app's default Storage bucket (Media Library objects live here). */
export function adminBucket() {
  return getStorage(app()).bucket();
}
