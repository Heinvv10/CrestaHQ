import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Keep the worker, dispatcher, and inbox index real. Only Firestore and the
// external provider/readiness boundary are replaced with local fixtures.
const docs = new Map<string, Record<string, unknown>>();
const sendBridge = vi.fn();
let failMessageWrite = false;
let autoId = 0;
let lastInboundAt: Date | null = null;

vi.mock("firebase-admin/firestore", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("firebase-admin/firestore")>();
  return {
    ...original,
    FieldValue: {
      ...original.FieldValue,
      serverTimestamp: () => "server-time",
      arrayUnion: (...values: unknown[]) => ({ union: values }),
      increment: (value: number) => ({ increment: value }),
    },
  };
});

function write(path: string, patch: Record<string, unknown>) {
  if (failMessageWrite && path.includes("/whatsappMessages/"))
    throw new Error("storage unavailable");
  const data = { ...docs.get(path) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && "union" in value) {
      data[key] = [
        ...((data[key] as unknown[]) ?? []),
        ...(value.union as unknown[]),
      ];
    } else if (value && typeof value === "object" && "increment" in value) {
      data[key] = Number(data[key] ?? 0) + Number(value.increment);
    } else data[key] = value;
  }
  docs.set(path, data);
}
function ref(path: string) {
  return {
    path,
    id: path.split("/").at(-1),
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").at(-1),
      data: () => docs.get(path),
    }),
    update: async (patch: Record<string, unknown>) => write(path, patch),
    set: async (patch: Record<string, unknown>) => write(path, patch),
    collection: (name: string) => collection(`${path}/${name}`),
  };
}
function collection(path: string) {
  return {
    doc: (id = `auto${++autoId}`) => ref(`${path}/${id}`),
    orderBy: () => ({
      limit: () => ({
        get: async () => ({
          docs: lastInboundAt
            ? [
                {
                  data: () => ({
                    direction: "inbound",
                    createdAt: { toDate: () => lastInboundAt },
                  }),
                },
              ]
            : [],
        }),
      }),
    }),
  };
}
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: ref,
    collection,
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: (r: ReturnType<typeof ref>) => r.get(),
        set: (r: ReturnType<typeof ref>, data: Record<string, unknown>) =>
          write(r.path, data),
        update: (r: ReturnType<typeof ref>, data: Record<string, unknown>) =>
          write(r.path, data),
      }),
  }),
}));
vi.mock("@/lib/comms/whatsapp/bridge-credentials", () => ({
  getBridgeCreds: async () => ({}),
}));
vi.mock("@/lib/comms/whatsapp/bridge-client", () => ({
  sendWhatsappBridge: (...args: unknown[]) => sendBridge(...args),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => ({
    ready: true,
    provider: docs.get("subAccounts/sa1")?.whatsappProvider ?? "bridge",
    sender: { phoneNumber: "+27780000000" },
  }),
}));

const { runStep } = await import("./engine");

beforeEach(() => {
  docs.clear();
  failMessageWrite = false;
  autoId = 0;
  lastInboundAt = null;
  sendBridge
    .mockReset()
    .mockResolvedValue({ ok: true, messageId: "bridge-msg-1" });
  docs.set("workflowRuns/run1", {
    workflowId: "wf1",
    contactId: "c1",
    subAccountId: "sa1",
    agencyId: "ag1",
    status: "running",
    history: [],
  });
  docs.set("workflows/wf1", {
    id: "wf1",
    status: "active",
    createdByUid: "u1",
    nodes: {
      n1: {
        id: "n1",
        type: "send_whatsapp",
        config: { body: "Hi {{contact.firstName}}" },
        next: null,
      },
    },
  });
  docs.set("contacts/c1", {
    name: "Thandi M",
    phone: "+27821234567",
    email: "",
    subAccountId: "sa1",
    agencyId: "ag1",
  });
  docs.set("subAccounts/sa1", {
    whatsappEnabledByAgency: true,
    whatsappProvider: "bridge",
    whatsappBridgeMeta: { displayPhoneNumber: "+27780000000" },
  });
});

it("records the delivered workflow WhatsApp in the contact thread and inbox", async () => {
  await runStep("run1", "n1");
  expect(docs.get("contacts/c1/whatsappMessages/bridge-msg-1")).toMatchObject({
    agencyId: "ag1",
    subAccountId: "sa1",
    contactId: "c1",
    direction: "outbound",
    status: "sent",
    body: "Hi Thandi",
    from: "+27780000000",
    to: "+27821234567",
    twilioMessageSid: "bridge-msg-1",
    sentByUid: null,
  });
  expect(docs.get("conversations/c1")).toMatchObject({
    agencyId: "ag1",
    subAccountId: "sa1",
    contactId: "c1",
    lastDirection: "outbound",
    lastMessagePreview: "Hi Thandi",
    lastChannel: "whatsapp",
    unreadCount: 0,
  });
});

it("persists the executor log in history.result and skips a completed retry", async () => {
  await runStep("run1", "n1");
  expect(docs.get("workflowRuns/run1")).toMatchObject({
    status: "completed",
    history: [{ nodeId: "n1", type: "send_whatsapp", result: "ok" }],
  });
  await runStep("run1", "n1");
  expect(sendBridge).toHaveBeenCalledTimes(1);
});

it("records a refusal in history without inventing an outbound message", async () => {
  sendBridge.mockResolvedValue({ ok: false, error: "reply_only" });
  await runStep("run1", "n1");
  expect(docs.get("workflowRuns/run1")).toMatchObject({
    history: [{ result: "error:reply_only" }],
  });
  expect(
    [...docs.keys()].filter((key) => key.includes("/whatsappMessages/"))
  ).toEqual([]);
  expect(docs.has("conversations/c1")).toBe(false);
});

it("makes a recording failure visible without retrying an already accepted send", async () => {
  failMessageWrite = true;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await runStep("run1", "n1");
    expect(docs.get("workflowRuns/run1")).toMatchObject({
      status: "completed",
      history: [{ result: "sent:message_record_failed" }],
    });
    await runStep("run1", "n1");
    expect(sendBridge).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: async () => ({
    phoneNumberId: "phone1",
    accessToken: "test-token",
  }),
}));
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "records actual Cloud content when window open=%s",
  async (open) => {
    docs.set("subAccounts/sa1", {
      whatsappEnabledByAgency: true,
      whatsappProvider: "cloud",
    });
    lastInboundAt = open ? new Date() : null;
    docs.set("subAccounts/sa1/whatsappTemplates/tpl1", {
      name: "follow_up",
      language: "en",
      body: "Welcome back {{1}}!",
      variables: [
        { position: 1, source: "merge_tag", mergeTag: "contact.firstName" },
      ],
      registrations: {
        cloud: { externalId: "tpl-external", status: "approved" },
      },
    });
    const wf = docs.get("workflows/wf1")!;
    (
      wf.nodes as Record<string, { config: Record<string, unknown> }>
    ).n1.config.templateId = "tpl1";
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), {
        status: 200,
      });
    });
    await runStep("run1", "n1");
    expect(requests[0].type).toBe(open ? "text" : "template");
    if (!open)
      expect(requests[0].template).toMatchObject({
        name: "follow_up",
        components: [
          { type: "body", parameters: [{ type: "text", text: "Thandi" }] },
        ],
      });
    expect(docs.get("contacts/c1/whatsappMessages/wamid.1")?.body).toBe(
      open ? "Hi Thandi" : "Welcome back Thandi!"
    );
    expect(docs.get("conversations/c1")?.lastMessagePreview).toBe(
      open ? "Hi Thandi" : "Welcome back Thandi!"
    );
  }
);
