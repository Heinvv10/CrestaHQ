import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Bulk-email broadcast harness: the real send / fanout / step / cancel routes
 * over the in-memory Firestore, with QStash replaced by an in-process queue
 * the test drains by hand. Nothing leaves the process — `sent` records what
 * would have been emailed.
 *
 * Usage: `vi.mock` the modules below from the test file (vi.mock is hoisted
 * per file), pointing each factory at `h`.
 */

export interface Published {
  pathname: string;
  body: Record<string, unknown>;
  delaySeconds: number;
  deduplicationId: string;
}

export const h = {
  mem: createMemoryFirestore(),
  /** Messages published and not yet delivered. */
  queue: [] as Published[],
  /** Every publish attempted, including failed ones. */
  publishLog: [] as Published[],
  /** Emails that reached the provider. */
  sent: [] as Array<{ contactId: string; to: string }>,
  /** Return true to make that publish fail (publishCallback → null). */
  failPublish: (_m: Published): boolean => false,
  /** Return true to make that publish THROW (the process died mid-request). */
  throwPublish: (_m: Published): boolean => false,
  smtpConnected: true,
  /** checkQuota throws while > 0 (a read blip before the provider call). */
  quotaThrows: 0,
  /** The next N batch commits fail (a write blip). */
  failCommits: 0,
  member: true,
  scope: { enforce: false, ids: null } as { enforce: boolean; ids: string[] | null },
};

/** The in-memory db, with `failCommits` injected into batch commits. */
export function harnessDb() {
  const db = h.mem.db;
  return {
    ...db,
    batch: () => {
      const b = db.batch();
      const commit = b.commit;
      return Object.assign(b, {
        commit: () =>
          h.failCommits-- > 0 ? Promise.reject(new Error("commit blip")) : commit(),
      });
    },
  };
}

export function resetHarness(): void {
  h.mem.clear();
  h.queue.length = 0;
  h.publishLog.length = 0;
  h.sent.length = 0;
  h.failPublish = () => false;
  h.throwPublish = () => false;
  h.smtpConnected = true;
  h.quotaThrows = 0;
  h.failCommits = 0;
  h.member = true;
  h.scope = { enforce: false, ids: null };
}

export const qstashMock = () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
  publishCallback: async (m: Published) => {
    h.publishLog.push(m);
    if (h.throwPublish(m)) throw new Error("process died mid-request");
    if (h.failPublish(m)) return null;
    h.queue.push(m);
    return { messageId: `m${h.publishLog.length}` };
  },
});

export const resendMock = () => ({
  emailIsConfigured: () => h.smtpConnected,
  tenantFrom: () => "sender@tenant.test",
  sendEmail: async (args: { contactId: string; to: string }) => {
    h.sent.push({ contactId: args.contactId, to: args.to });
    return { id: `msg${h.sent.length}` };
  },
});

export function seedTenant(
  contacts: number,
  sub: Record<string, unknown> = {},
): void {
  h.mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    name: "Tenant",
    broadcastsEnabledByAgency: true,
    automationsPaused: false,
    ...sub,
  });
  h.mem.seed("agencies/ag1", {});
  h.mem.seed("message_templates/t1", {
    subAccountId: "sa1",
    agencyId: "ag1",
    type: "email",
    name: "Newsletter",
    subject: "Hello",
    body: "Hi {{contact.firstName}}\n{{unsubscribeLink}}",
  });
  for (let i = 0; i < contacts; i++) {
    const id = `c${String(i).padStart(4, "0")}`;
    h.mem.seed(`contacts/${id}`, {
      subAccountId: "sa1",
      name: `Contact ${i}`,
      email: `${id}@example.test`,
      phone: "",
      tags: [],
    });
  }
}

export const usageMock = () => ({
  checkQuota: async () => {
    if (h.quotaThrows > 0) {
      h.quotaThrows -= 1;
      throw new Error("quota read blip");
    }
    return { allowed: true };
  },
});

export const tenancyMocks = {
  tenancy: async () => {
    const { NextResponse } = await import("next/server");
    return {
      requireSubAccountMember: async () =>
        h.member
          ? { uid: "u1", email: "op@tenant.test" }
          : NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  },
  territory: () => ({ loadEffectiveTerritoryScope: async () => h.scope }),
};

type Handler = (req: Request) => Promise<Response>;
const routes: Record<string, () => Promise<{ POST: Handler }>> = {
  "/api/broadcasts/email/send": () =>
    import("@/app/api/broadcasts/email/send/route") as Promise<{ POST: Handler }>,
  "/api/broadcasts/email/step": () =>
    import("@/app/api/broadcasts/email/step/route") as Promise<{ POST: Handler }>,
};

/** Register a route the harness cannot import statically (new in a fix). */
export function addRoute(pathname: string, load: () => Promise<{ POST: Handler }>): void {
  routes[pathname] = load;
}

export async function call(
  pathname: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const load = routes[pathname];
  if (!load) throw new Error(`harness: no route for ${pathname}`);
  const { POST } = await load();
  return POST(
    new Request(`https://app.test${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", "upstash-signature": "sig", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** Deliver queued messages (FIFO) until the queue is empty or `only` rejects the next. */
export async function drain(
  only: (m: Published) => boolean = () => true,
): Promise<Response[]> {
  const responses: Response[] = [];
  for (;;) {
    const i = h.queue.findIndex(only);
    if (i === -1) return responses;
    const [m] = h.queue.splice(i, 1);
    responses.push(await call(m!.pathname, m!.body));
  }
}

export const isStep = (m: Pick<Published, "pathname">) => m.pathname === "/api/broadcasts/email/step";

export function sendBroadcast(key = "key-00000001"): Promise<Response> {
  return call("/api/broadcasts/email/send", {
    subAccountId: "sa1",
    templateId: "t1",
    audienceFilter: { kind: "all" },
    idempotencyKey: key,
  });
}

export const broadcasts = () => h.mem.list("broadcasts");
