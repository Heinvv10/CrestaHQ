import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  type User,
} from "firebase/auth";
import { getFirebaseAuth } from "./client";

const SIGN_IN_RETRY_DELAYS_MS = [1_000, 2_000];
const SIGN_IN_MAX_ATTEMPTS = SIGN_IN_RETRY_DELAYS_MS.length + 1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CI's self-hosted E2E runner shares a box with heavy Docker veth churn;
 * Chrome aborts in-flight requests on a network interface change, so
 * signInWithEmailAndPassword can fail with `auth/network-request-failed`
 * even though the credentials are correct. Retry only that code — any other
 * failure (wrong password, too-many-requests, disabled user) is final and
 * must not be retried.
 */
function isNetworkRequestFailed(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "auth/network-request-failed";
}

export async function signInWithEmail(email: string, password: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SIGN_IN_MAX_ATTEMPTS; attempt++) {
    try {
      const credential = await signInWithEmailAndPassword(
        getFirebaseAuth(),
        email,
        password,
      );
      await createSessionCookie(credential.user);
      return credential;
    } catch (err) {
      lastError = err;
      if (!isNetworkRequestFailed(err) || attempt === SIGN_IN_MAX_ATTEMPTS) {
        throw err;
      }
      await delay(SIGN_IN_RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw lastError;
}

export async function signUpWithEmail(email: string, password: string) {
  const credential = await createUserWithEmailAndPassword(
    getFirebaseAuth(),
    email,
    password,
  );
  await createSessionCookie(credential.user);
  return credential;
}

export async function signOutUser() {
  await fetch("/api/logout", { method: "GET" }).catch((err) =>
    console.warn("logout endpoint failed", err),
  );
  return signOut(getFirebaseAuth());
}

/**
 * Send a Firebase password-reset email. The link in the email lands on
 * Firebase's hosted action handler which lets the user pick a new
 * password. Always resolves to void on the client side — Firebase doesn't
 * tell us whether the address exists (by design, to avoid email
 * enumeration). UI should show the same success message regardless.
 */
export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(getFirebaseAuth(), email);
}

/**
 * Check a reset code from the emailed link (`/login?mode=resetPassword&
 * oobCode=…`). Resolves to the account's email; throws when the code is
 * expired, already used or malformed.
 */
export async function verifyPasswordReset(code: string): Promise<string> {
  return verifyPasswordResetCode(getFirebaseAuth(), code);
}

/** Spend a reset code to set a new password. Does not sign the user in. */
export async function completePasswordReset(
  code: string,
  newPassword: string,
): Promise<void> {
  await confirmPasswordReset(getFirebaseAuth(), code, newPassword);
}

/**
 * Change the current user's password. Firebase requires recent auth for
 * sensitive changes — we re-authenticate first with the user's current
 * password, then update. On a stale session this surfaces a clear
 * auth/wrong-password error instead of the confusing
 * auth/requires-recent-login that updatePassword would otherwise throw.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error("Not signed in.");
  }
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, newPassword);
}

/**
 * Exchange the Firebase ID token for the __session cookie that
 * next-firebase-auth-edge middleware uses to gate protected routes.
 */
async function createSessionCookie(user: User): Promise<void> {
  const idToken = await user.getIdToken();
  const res = await fetch("/api/login", {
    method: "GET",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Session cookie request failed: ${res.status} ${res.statusText}`,
    );
  }
}
