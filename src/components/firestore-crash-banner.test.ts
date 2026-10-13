// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The SDK logger's user handler, as registered through firebase/app's onLog. */
const sdk = vi.hoisted(() => ({ handler: null as null | ((log: { level: string; message: string }) => void) }));
vi.mock("firebase/app", () => ({
  onLog: (cb: typeof sdk.handler) => {
    sdk.handler = cb;
  },
}));

import { FirestoreCrashBanner } from "./firestore-crash-banner";

const CA9 = 'FIRESTORE (12.19.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: ca9) CONTEXT: {"ve":-1}';

let container: HTMLDivElement;
let root: Root;
let consoleError: ReturnType<typeof vi.spyOn>;
// jsdom's location.reload cannot be spied on in place; the whole location can be stubbed.
const reload = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  reload.mockClear();
  vi.stubGlobal("location", { ...window.location, reload });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(FirestoreCrashBanner)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const banner = () => container.querySelector('[data-testid="firestore-crash-banner"]');
const uncaught = (error: unknown) =>
  act(async () => {
    window.dispatchEvent(new ErrorEvent("error", { error, message: error instanceof Error ? error.message : String(error) }));
  });
const rejected = (reason: unknown) =>
  act(async () => {
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
  });
const logged = (message: string) =>
  act(async () => {
    sdk.handler?.({ level: "error", message });
  });

describe("FirestoreCrashBanner", () => {
  it("renders nothing until the SDK crashes", () => {
    expect(banner()).toBeNull();
  });

  it.each([
    ["an uncaught error", () => uncaught(new Error(CA9))],
    ["an unhandled rejection", () => rejected(new Error(CA9))],
    ["the SDK's logger", () => logged(`Firestore (12.19.0): INTERNAL UNHANDLED ERROR:  ${CA9}`)],
  ])("raises a non-dismissable banner with a Reload button on %s", async (_via, crash) => {
    await crash();
    expect(banner()?.getAttribute("role")).toBe("alert");
    expect(banner()?.textContent).toContain("Connection to the server was lost. Reload to continue.");
    const buttons = Array.from(banner()!.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Reload"]);
  });

  it("never reloads by itself, reloads once on a click, and takes focus so a keypress does it", async () => {
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();
    await uncaught(new Error(CA9));
    expect(reload).not.toHaveBeenCalled();
    const button = banner()!.querySelector("button")!;
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(reload).toHaveBeenCalledTimes(1);
    elsewhere.remove();
  });

  it("logs the message once — a string, never the error object — however many follow", async () => {
    await uncaught(new Error(CA9));
    await uncaught(new Error(CA9.replace("ca9", "b815")));
    await logged(CA9);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toEqual([`[firestore] client crashed; asking for a reload: ${CA9}`]);
  });

  it.each([
    ["an uncaught TypeError", () => uncaught(new TypeError("Cannot read properties of undefined (reading 'x')"))],
    ["an uncaught string", () => uncaught("Script error.")],
    ["a rejected network error", () => rejected(new Error("Firebase: Error (auth/network-request-failed)."))],
    ["a rejection with no reason", () => rejected(undefined)],
    ["a permission error from the logger", () => logged("Firestore (12.19.0): Uncaught Error in snapshot listener: Missing or insufficient permissions.")],
    ["Firestore's offline warning", () => logged("Firestore (12.19.0): Could not reach Cloud Firestore backend.")],
  ])("stays hidden, and logs nothing, on %s", async (_what, other) => {
    await other();
    expect(banner()).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("lets go of every listener on unmount", async () => {
    const removed = vi.spyOn(window, "removeEventListener");
    await act(async () => root.unmount());
    expect(sdk.handler).toBeNull();
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(["error", "unhandledrejection"]);
    root = createRoot(container);
  });
});
