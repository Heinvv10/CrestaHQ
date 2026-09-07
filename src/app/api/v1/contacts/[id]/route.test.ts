import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/v1/contacts/:id — a tag applied over the API must enrol the
 * contact exactly as a tag applied in the dashboard does.
 *
 * Driven down through `updateContactServerSide`, which owns the tag diff.
 * The route must not carry a copy of it, so the test asserts the trigger's
 * `addedTags` — the diff's output — rather than that some function was called.
 */

const CTX = {
  agencyId: "ag1",
  subAccountId: "sa1",
  keyId: "key1",
  keyPrefix: "lsk_abcd",
  mode: "live" as "live" | "test",
  scopes: ["admin"],
  requestId: "req_test",
  apiVersion: "2026-01-01",
};

let contact: Record<string, unknown> | undefined;
/** The key's hour bucket, mutated by the real reserve/reconcile paths. */
let enrolmentCount = 0;
/** Makes the contact update blow up, as a Firestore outage would. */
let updateThrows = false;
/** Deletes the contact between the route's tenancy read and the service's. */
let vanishAfterTenancyRead = false;
let contactReads = 0;
const contactUpdates: Array<Record<string, unknown>> = [];
const fireWorkflowTrigger = vi.fn();
const emitWebhookEvent = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  withApiAuth:
    (handler: (input: Record<string, unknown>) => Promise<Response>) =>
    async (request: Request, routeCtx: { params: Promise<{ id: string }> }) => {
      const rawBody = await request.text();
      return handler({
        request,
        params: await routeCtx.params,
        body: rawBody ? JSON.parse(rawBody) : null,
        rawBody,
        ctx: CTX,
      });
    },
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({
  emitWebhookEvent: (...a: unknown[]) => emitWebhookEvent(...a),
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: (...a: unknown[]) => fireWorkflowTrigger(...a),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    runTransaction: async <T>(
      fn: (tx: {
        get: (ref: unknown) => Promise<{ data: () => unknown }>;
        set: (ref: unknown, data: Record<string, unknown>) => void;
      }) => Promise<T>
    ): Promise<T> =>
      fn({
        get: async () => ({ data: () => ({ count: enrolmentCount }) }),
        set: (_ref, data) => {
          enrolmentCount = data.count as number;
        },
      }),
    doc: (path: string) => {
      if (path === "contacts/c1") {
        return {
          id: "c1",
          get: async () => {
            contactReads += 1;
            const gone = vanishAfterTenancyRead && contactReads > 1;
            return { exists: !!contact && !gone, data: () => contact };
          },
          update: async (patch: Record<string, unknown>) => {
            if (updateThrows) throw new Error("firestore unavailable");
            contactUpdates.push(patch);
            contact = { ...contact, ...patch };
          },
        };
      }
      if (path.startsWith("subAccounts/sa1/apiEnrolments/")) {
        return {
          path,
          set: async (data: Record<string, unknown>) => {
            const delta = (data.count as { operand?: number }).operand ?? 0;
            enrolmentCount += delta;
          },
        };
      }
      throw new Error(`unexpected doc ${path}`);
    },
    collection: (path: string) => {
      if (path === "subAccounts/sa1/customFields") {
        const q = { where: () => q, get: async () => ({ docs: [] }) };
        return q;
      }
      throw new Error(`unexpected collection ${path}`);
    },
  }),
}));

const { PATCH } = await import("./route");

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request("https://app.test/api/v1/contacts/c1", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "c1" }) }
  ) as unknown as Promise<Response>;
}

beforeEach(() => {
  CTX.mode = "live";
  contact = {
    name: "Thandi",
    email: "",
    phone: "",
    tags: ["lead"],
    subAccountId: "sa1",
    agencyId: "ag1",
    mode: "live",
  };
  enrolmentCount = 0;
  updateThrows = false;
  vanishAfterTenancyRead = false;
  contactReads = 0;
  contactUpdates.length = 0;
  fireWorkflowTrigger.mockReset();
  emitWebhookEvent.mockReset();
});

describe("PATCH /api/v1/contacts/:id — workflow triggers", () => {
  it("fires contact.tag.added once, with only the NEW tags", async () => {
    const res = await patch({ tags: ["lead", "audit-booked"] });

    expect(res.status).toBe(200);
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(1);
    expect(fireWorkflowTrigger).toHaveBeenCalledWith({
      subAccountId: "sa1",
      agencyId: "ag1",
      type: "contact.tag.added",
      contactId: "c1",
      context: { addedTags: ["audit-booked"] },
      apiKeyId: "key1",
    });
    // The reservation stays charged — the trigger owns it from here.
    expect(enrolmentCount).toBe(1);
  });

  it("fires nothing, and RELEASES its reservation, when tags don't change", async () => {
    const res = await patch({ tags: ["lead"], name: "Thandi M" });

    expect(res.status).toBe(200);
    expect(contactUpdates).toHaveLength(1);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    // contact.updated still fires — only the enrolment trigger is silent.
    expect(emitWebhookEvent).toHaveBeenCalledTimes(1);
    // Asserted on the BUCKET, not on the mocked trigger: `fireWorkflowTrigger`
    // is mocked, so "it wasn't called" cannot see whether the reservation
    // this route charged was ever handed back. An ordinary PATCH that leaks
    // a slot 429s the key for the hour over workflows that never ran.
    expect(enrolmentCount).toBe(0);
  });

  it("releases its reservation on a PATCH that carries no tags at all", async () => {
    const res = await patch({ name: "Thandi M" });

    expect(res.status).toBe(200);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    expect(enrolmentCount).toBe(0);
  });

  it("releases its reservation when the contact vanishes before the write", async () => {
    vanishAfterTenancyRead = true;

    const res = await patch({ tags: ["lead", "audit-booked"] });

    expect(res.status).toBe(404);
    expect(enrolmentCount).toBe(0);
  });

  it("releases its reservation when the write throws after it", async () => {
    updateThrows = true;

    await expect(patch({ tags: ["lead", "new"] })).rejects.toThrow(
      "firestore unavailable"
    );
    expect(enrolmentCount).toBe(0);
    expect(contactUpdates).toEqual([]);
  });

  it("fires nothing for a test-mode tag add", async () => {
    CTX.mode = "test";
    contact = { ...contact, mode: "test" };

    const res = await patch({ tags: ["lead", "audit-booked"] });

    expect(res.status).toBe(200);
    expect(contactUpdates).toHaveLength(1);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    // Test mode reserves nothing, so it must release nothing.
    expect(enrolmentCount).toBe(0);
  });

  it("keeps the API error shape for a contact in another sub-account", async () => {
    contact = { ...contact, subAccountId: "other" };
    const res = await patch({ tags: ["x"] });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("contact_not_found");
    expect(contactUpdates).toEqual([]);
  });
});

describe("PATCH /api/v1/contacts/:id — hourly enrolment cap", () => {
  it("accepts the request that sits one under the cap", async () => {
    enrolmentCount = 49;
    const res = await patch({ tags: ["lead", "audit-booked"] });

    expect(res.status).toBe(200);
    expect(contactUpdates).toHaveLength(1);
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(1);
  });

  it("refuses back-to-back tag adds once the reservations reach the cap", async () => {
    // No trigger settles here (the engine is mocked), so only the
    // reservations bound the loop.
    enrolmentCount = 48;
    const statuses: number[] = [];
    for (const tag of ["a", "b", "c"]) {
      statuses.push((await patch({ tags: ["lead", tag] })).status);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect(contactUpdates).toHaveLength(2);
  });

  it("REFUSES with 429 at the cap, leaving the contact unchanged", async () => {
    enrolmentCount = 50;
    const res = await patch({ tags: ["lead", "audit-booked"] });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("workflow_enrolment_cap");
    // Refused, not truncated: the tag is not on the contact and nobody enrolled.
    expect(contactUpdates).toEqual([]);
    expect(contact!.tags).toEqual(["lead"]);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    expect(emitWebhookEvent).not.toHaveBeenCalled();
    // The refused reservation was handed straight back.
    expect(enrolmentCount).toBe(50);
  });
});

it("stores duplicate tags once and emits each added tag once", async () => {
  const res = await patch({ tags: ["lead", "audit", "audit", "lead"] });
  expect(res.status).toBe(200);
  expect(contact!.tags).toEqual(["lead", "audit"]);
  expect(fireWorkflowTrigger).toHaveBeenCalledWith(
    expect.objectContaining({
      context: { addedTags: ["audit"] },
    })
  );
});
