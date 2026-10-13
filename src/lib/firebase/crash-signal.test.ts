import { describe, expect, it } from "vitest";
import { firestoreCrashMessage } from "./crash-signal";

const CA9 = 'FIRESTORE (12.10.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: ca9) CONTEXT: {"ve":-1}';

describe("firestoreCrashMessage", () => {
  it.each([
    ["an Error", new Error(CA9)],
    ["a string", CA9],
    ["an error-shaped object", { message: CA9 }],
    ["the SDK logger's line", `Firestore (12.10.0): INTERNAL UNHANDLED ERROR:  Error: ${CA9}`],
    ["the b815 follow-up", "FIRESTORE (12.19.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: b815) CONTEXT: {}"],
  ])("recognises the crash as %s", (_shape, value) => {
    expect(firestoreCrashMessage(value)).toContain("INTERNAL ASSERTION FAILED");
  });

  it.each([
    ["a network error", new Error("Firebase: Error (auth/network-request-failed).")],
    ["a Firestore permission error", new Error("Missing or insufficient permissions.")],
    ["an ordinary TypeError", new TypeError("Cannot read properties of undefined (reading 'x')")],
    ["the Realtime Database's assertion", new Error("FIREBASE INTERNAL ERROR: Server Error")],
    ["an assertion that is not Firestore's", new Error("INTERNAL ASSERTION FAILED: something else")],
    ["Firestore's offline warning", "Firestore (12.10.0): Could not reach Cloud Firestore backend."],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
  ])("ignores %s", (_shape, value) => {
    expect(firestoreCrashMessage(value)).toBeNull();
  });
});
