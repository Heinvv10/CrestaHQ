import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT …/gbp/widget with `expectedPublicId`: a save from a form opened on
 * another state of the widget (a "create" form after someone else created
 * it, or a form left open across a rotate / revoke) writes nothing and
 * answers 409 widget_changed. Through the real route on the in-memory store.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { DELETE, PUT } from "./route";
import { POST as ROTATE } from "./rotate/route";

const URL_ = `http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/widget`;
const params = { params: Promise.resolve({ id: SA }) };
const VELO = "https://www.velocityfibre.co.za";
const OTHER = "https://other.example";
const config = (origin: string) => ({ enabled: true, allowedOrigins: [origin], maxReviews: 12 });

async function put(body: unknown) {
  const res = await PUT(asUser(URL_, "uid_admin", "PUT", JSON.stringify(body)), params);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const meta = () => mem.read(`subAccounts/${SA}`)?.gbpWidgetMeta as Record<string, unknown> | null | undefined;
const stored = () => mem.list("gbpWidgets");
async function created(): Promise<string> {
  const { status, body } = await put({ ...config(VELO), expectedPublicId: null });
  expect(status).toBe(200);
  return (body.widget as { publicId: string }).publicId;
}

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("expectedPublicId", () => {
  it("creates when the caller saw no widget and there is none", async () => {
    await created();
    expect(meta()).toMatchObject({ allowedOrigins: [VELO] });
  });

  it("refuses a 'create' when a widget now exists — its origins and id untouched", async () => {
    const id = await created();
    const before = { meta: meta(), docs: stored() };
    const res = await put({ ...config(OTHER), layout: "grid", expectedPublicId: null });
    expect(res).toEqual({ status: 409, body: { code: "widget_changed", error: expect.stringContaining("Reload") } });
    expect(meta()).toEqual(before.meta);
    expect(stored()).toEqual(before.docs);
    expect(stored()).toEqual([expect.objectContaining({ id, allowedOrigins: [VELO], layout: "carousel" })]);
    expect(meta()?.publicId).toBe(id);
  });

  it("updates when the caller saw the stored widget", async () => {
    const id = await created();
    const res = await put({ ...config(OTHER), expectedPublicId: id });
    expect(res.status).toBe(200);
    expect(meta()).toMatchObject({ publicId: id, allowedOrigins: [OTHER] });
  });

  it("refuses a save from a form opened before a rotate", async () => {
    const id = await created();
    await ROTATE(asUser(`${URL_}/rotate`, "uid_admin", "POST"), params);
    const rotated = meta()?.publicId;
    expect(rotated).not.toBe(id);
    expect((await put({ ...config(OTHER), expectedPublicId: id })).status).toBe(409);
    expect(meta()).toMatchObject({ publicId: rotated, allowedOrigins: [VELO] });
  });

  it("refuses a save from a form opened before a revoke — it does not recreate the widget", async () => {
    const id = await created();
    await DELETE(asUser(URL_, "uid_admin", "DELETE"), params);
    expect((await put({ ...config(OTHER), expectedPublicId: id })).status).toBe(409);
    expect(meta()).toBeNull();
    expect(stored()).toEqual([]);
  });

  it("without it, a save is unconditional (curl and scripts keep working)", async () => {
    await created();
    expect((await put(config(OTHER))).status).toBe(200);
    expect(meta()).toMatchObject({ allowedOrigins: [OTHER] });
  });

  it.each([[42], ["not-an-id"], [""], [["x"]]])("refuses expectedPublicId %j with 400 and writes nothing", async (bad) => {
    const res = await put({ ...config(VELO), expectedPublicId: bad });
    expect(res).toEqual({ status: 400, body: { code: "invalid_body", error: expect.any(String) } });
    expect(meta() ?? null).toBeNull();
  });
});
