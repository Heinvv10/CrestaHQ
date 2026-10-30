import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const signInWithEmailAndPassword = vi.fn();
const sendPasswordResetEmail = vi.fn();

vi.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...args: unknown[]) =>
    signInWithEmailAndPassword(...args),
  createUserWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  sendPasswordResetEmail: (...args: unknown[]) => sendPasswordResetEmail(...args),
  EmailAuthProvider: { credential: vi.fn() },
  reauthenticateWithCredential: vi.fn(),
  updatePassword: vi.fn(),
}));

vi.mock("./client", () => ({
  getFirebaseAuth: vi.fn(() => ({})),
}));

// Import after mocks are registered.
import { sendPasswordReset, signInWithEmail } from "./auth";

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

describe("sendPasswordReset", () => {
  const replyWith = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => body })),
    );

  beforeEach(() => {
    vi.useFakeTimers();
    sendPasswordResetEmail.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries Firebase's fallback send through a network error", async () => {
    replyWith({ fallback: true });
    sendPasswordResetEmail
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(undefined);

    const promise = sendPasswordReset("a@b.com");
    await vi.runAllTimersAsync();
    await promise;

    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(2);
    expect(sendPasswordResetEmail).toHaveBeenLastCalledWith({}, "a@b.com");
  });

  it("throws immediately on a non-network Firebase error without retrying", async () => {
    replyWith({ fallback: true });
    sendPasswordResetEmail.mockRejectedValue(
      Object.assign(new Error("bad email"), { code: "auth/invalid-email" }),
    );

    await expect(sendPasswordReset("a@b.com")).rejects.toMatchObject({
      code: "auth/invalid-email",
    });
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it("never asks Firebase when the server sent the mail", async () => {
    replyWith({ ok: true });
    await sendPasswordReset("a@b.com");
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
