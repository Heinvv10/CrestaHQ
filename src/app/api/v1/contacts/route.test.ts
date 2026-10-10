import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/contacts — the public API must enrol contacts in workflows,
 * and must refuse to keep doing it when a script runs away.
 *
 * The route is exercised end-to-end down to `createContactServerSide` (the
 * same chokepoint the dashboard uses) with only Firestore, the webhook
 * dispatcher and the workflow engine faked. Mocking the service instead
 * would prove the route calls a function, not that a tag applied over the
 * API actually enrols anybody.
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

/** The key's hour bucket, mutated by the real reserve/reconcile paths. */
let enrolmentCount = 0;
/** Makes the contact write blow up, as a Firestore outage would. */
let createThrows = false;
const contactsCreated: Array<{ id: string; data: Record<string, unknown> }> =
  [];
const fireWorkflowTrigger = vi.fn();
const emitWebhookEvent = vi.fn();

vi.mock("@/lib/api/auth", () => ({
  withApiAuth:
    (handler: (input: Record<string, unknown>) => Promise<Response>) =>
    async (request: Request) => {
      const rawBody = await request.text();
      return handler({
        request,
        params: {},
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
      if (path === "subAccounts/sa1") {
        return {
          get: async () => ({
            exists: true,
            data: () => ({ defaultPhoneCountry: "ZA" }),
          }),
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
      if (path === "contacts") {
        return {
          doc: () => {
            const id = `c${contactsCreated.length + 1}`;
            return {
              id,
              set: async (data: Record<string, unknown>) => {
                if (createThrows) throw new Error("firestore unavailable");
                contactsCreated.push({ id, data });
              },
            };
          },
        };
      }
      if (path === "subAccounts/sa1/customFields") {
        const q = { where: () => q, get: async () => ({ docs: [] }) };
        return q;
      }
      throw new Error(`unexpected collection ${path}`);
    },
  }),
}));

const { POST } = await import("./route");

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("https://app.test/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: undefined }
  ) as unknown as Promise<Response>;
}

beforeEach(() => {
  CTX.mode = "live";
  enrolmentCount = 0;
  createThrows = false;
  contactsCreated.length = 0;
  fireWorkflowTrigger.mockReset();
  emitWebhookEvent.mockReset();
});

describe("POST /api/v1/contacts — workflow triggers", () => {
  it("fires contact.created exactly once, against this API key", async () => {
    const res = await post({ name: "Thandi", tags: ["lead"] });

    expect(res.status).toBe(201);
    expect(contactsCreated).toHaveLength(1);
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(1);
    expect(fireWorkflowTrigger).toHaveBeenCalledWith({
      subAccountId: "sa1",
      agencyId: "ag1",
      type: "contact.created",
      contactId: "c1",
      apiKeyId: "key1",
    });
    // The reservation stays charged — the trigger owns it now, and its
    // `finally` reconciles once it settles (the engine is mocked here).
    expect(enrolmentCount).toBe(1);
    // The webhook the route already emitted must survive the move.
    await vi.waitFor(() => expect(emitWebhookEvent).toHaveBeenCalledTimes(1));
    expect(emitWebhookEvent.mock.calls[0]![0]).toMatchObject({
      type: "contact.created",
    });
  });

  it("INVARIANT: every live create fires a trigger, so the engine always settles the reservation", async () => {
    // This route has no release path — see the comment above its gate. That
    // is only safe while `contact.created` fires for EVERY live create,
    // whatever the body contains. Make the create conditional and this goes
    // red: the reservation would be charged with nothing left to settle it.
    const res = await post({ name: "No tags, no email, no anything" });

    expect(res.status).toBe(201);
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(1);
    expect(fireWorkflowTrigger.mock.calls[0]![0]).toMatchObject({
      type: "contact.created",
      apiKeyId: "key1",
    });
    // Charged and outstanding — owned by the trigger's `finally`, which is
    // mocked away here, so the count stays at 1.
    expect(enrolmentCount).toBe(1);
  });

  it("writes a test-mode contact but fires NO trigger", async () => {
    CTX.mode = "test";
    const res = await post({ name: "Sandbox" });

    expect(res.status).toBe(201);
    expect(contactsCreated).toHaveLength(1);
    expect(contactsCreated[0]!.data.mode).toBe("test");
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    // Nothing was reserved, so nothing may be released either — a stray
    // release here would drive the bucket negative.
    expect(enrolmentCount).toBe(0);
  });

  it("still serializes the API wire shape", async () => {
    const res = await post({ name: "Thandi", tags: ["lead"], email: "t@x.co" });
    const body = (await res.json()) as { contact: Record<string, unknown> };
    expect(body.contact).toMatchObject({
      id: "c1",
      object: "contact",
      livemode: true,
      name: "Thandi",
      email: "t@x.co",
      tags: ["lead"],
    });
  });
});

describe("POST /api/v1/contacts — hourly enrolment cap", () => {
  it("accepts the request that sits one under the cap", async () => {
    enrolmentCount = 49;
    const res = await post({ name: "Number fifty" });

    expect(res.status).toBe(201);
    expect(contactsCreated).toHaveLength(1);
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(1);
  });

  it("REFUSES with 429 at the cap, and does not write the contact", async () => {
    enrolmentCount = 50;
    const res = await post({ name: "Number fifty-one" });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("workflow_enrolment_cap");
    // Refused, not silently truncated: nothing written, nothing enrolled.
    expect(contactsCreated).toEqual([]);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
    expect(emitWebhookEvent).not.toHaveBeenCalled();
    expect(res.headers.get("Retry-After")).toBeTruthy();
    // The refused reservation was handed straight back.
    expect(enrolmentCount).toBe(50);
  });

  it("releases the reservation when the write throws after it", async () => {
    createThrows = true;

    await expect(post({ name: "Doomed" })).rejects.toThrow(
      "firestore unavailable"
    );
    // withApiAuth turns the throw into a 500. Nothing enrolled, so the slot
    // must not stay held for the rest of the hour.
    expect(enrolmentCount).toBe(0);
    expect(contactsCreated).toEqual([]);
  });

  it("refuses the 51st back-to-back request even though no trigger has settled", async () => {
    // The engine is mocked, so NOTHING reconciles — exactly the state a
    // tight loop is in: every request's enrolments are still in flight.
    // A cap that only READ the counter would let all 51 through, because
    // no increment would have landed yet.
    const statuses: number[] = [];
    for (let i = 0; i < 51; i += 1) {
      statuses.push((await post({ name: `Lead ${i}` })).status);
    }

    expect(statuses.slice(0, 50)).toEqual(Array(50).fill(201));
    expect(statuses[50]).toBe(429);
    expect(contactsCreated).toHaveLength(50);
  });

  it("never refuses a test-mode write — it can enrol nobody", async () => {
    CTX.mode = "test";
    enrolmentCount = 5000;
    const res = await post({ name: "Sandbox" });

    expect(res.status).toBe(201);
    expect(contactsCreated).toHaveLength(1);
  });
});

it("stores each tag once on contact creation", async () => {
  const res = await post({ name: "Thandi", tags: ["lead", "audit", "lead"] });
  expect(res.status).toBe(201);
  expect(contactsCreated[0].data.tags).toEqual(["lead", "audit"]);
});
