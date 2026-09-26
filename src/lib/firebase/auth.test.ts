import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const signInWithEmailAndPassword = vi.fn();

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...args: unknown[]) =>
    signInWithEmailAndPassword(...args),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() },
  reauthenticateWithCredential: vi.fn(),
  updatePassword: vi.fn(),
}));

vi.mock("./client", () => ({
  getFirebaseAuth: vi.fn(() => ({})),
}));

// Import after mocks are registered.
import { signInWithEmail } from "./auth";

function networkError() {
  return Object.assign(new Error("network"), {
    code: "auth/network-request-failed",
  });
}

function fakeUser() {
  return {
    getIdToken: vi.fn(async () => "id-token"),
  };
}

describe("signInWithEmail", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    signInWithEmailAndPassword.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("recovers after two network errors and succeeds on the third attempt", async () => {
    const user = fakeUser();
    signInWithEmailAndPassword
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ user });

    const promise = signInWithEmail("a@b.com", "pw");
    await vi.runAllTimersAsync();
    const credential = await promise;

    expect(credential.user).toBe(user);
    expect(signInWithEmailAndPassword).toHaveBeenCalledTimes(3);
  });

  it("throws the network error after 3 attempts when it never recovers", async () => {
    signInWithEmailAndPassword.mockRejectedValue(networkError());

    const assertion = expect(signInWithEmail("a@b.com", "pw")).rejects.toMatchObject({
      code: "auth/network-request-failed",
    });
    await vi.runAllTimersAsync();
    await assertion;

    expect(signInWithEmailAndPassword).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on a non-network error without retrying", async () => {
    const invalidCredential = Object.assign(new Error("bad creds"), {
      code: "auth/invalid-credential",
    });
    signInWithEmailAndPassword.mockRejectedValue(invalidCredential);

    await expect(signInWithEmail("a@b.com", "pw")).rejects.toMatchObject({
      code: "auth/invalid-credential",
    });

    expect(signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
  });
});
