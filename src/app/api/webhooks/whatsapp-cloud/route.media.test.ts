import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cloud inbound media, driven through the real POST.
 *
 * Firestore is an in-memory store with real merge semantics (including
 * `FieldValue.delete()`), so a second delivery sees exactly what the first one
 * left behind. `fetch` is stubbed globally — the route owns no injection seam,
 * and adding one only for tests would test the seam instead of the route.
 */

const TOKEN = "EAAG-live-looking-secret-token-9f3a";

const m = vi.hoisted(() => ({
  DELETE: "__FIELDVALUE_DELETE__",
  docs: new Map<string, Record<string, unknown>>(),
  sets: [] as Array<{ path: string; data: Record<string, unknown> }>,
  contactIds: ["c_1"],
  conversationUpserts: [] as Array<Record<string, unknown>>,
  aiCalls: [] as Array<Record<string, unknown>>,
  puts: [] as Array<{ path: string; bytes: Buffer; contentType: string }>,
  putThrows: false,
  /** Set to make the store refuse without throwing, as an unset bucket does. */
  putRefuses: false,
  /** Storage paths whose store refuses, for a partial multi-contact failure. */
  putRefusesFor: new Set<string>(),
  /** Set to make the store never settle, as a hung `file.save` does. */
  putHangs: false,
  putCalls: 0,
  /** Contacts whose text-row write throws. */
  rowWriteFailsFor: new Set<string>(),
  /** Set to make the opt-out batch commit throw, as contention would. */
  commitThrows: false,
  contactUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "SERVER_TS", delete: () => m.DELETE },
}));
vi.mock("@/lib/comms/meta", () => ({
  verifyMetaSignature: () => true,
  metaWebhookVerifyToken: () => "tok",
}));
vi.mock("@/lib/comms/whatsapp/resolve-sender", () => ({
  hasWhatsappSenderOnRail: () => true,
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => true }));
vi.mock("@/lib/comms/ai/agent", () => ({
  resolveAgent: async () => ({ effective: { enabled: true } }),
}));
vi.mock("@/lib/comms/ai/respond", () => ({
  maybeRespondWithAi: async (a: Record<string, unknown>) => {
    m.aiCalls.push(a);
  },
}));
vi.mock("@/lib/server/contacts-service", () => ({
  createContactServerSide: async () => {
    throw new Error("not expected — the fixture contact already exists");
  },
}));
vi.mock("@/lib/server/conversations-service", () => ({
  upsertConversationForMessage: async (a: Record<string, unknown>) => {
    m.conversationUpserts.push(a);
  },
}));
vi.mock("@/lib/server/contact-activities", () => ({
  writeInboundMessageActivity: async () => {},
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  getWabaCreds: async () => ({
    phoneNumberId: "pn_1",
    wabaId: "waba_1",
    accessToken: TOKEN,
  }),
}));
vi.mock("@/lib/comms/whatsapp/media-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/whatsapp/media-storage")>()),
  putWhatsappMedia: async (o: { path: string; bytes: Buffer; contentType: string }) => {
    m.putCalls++;
    if (m.putHangs) return new Promise<never>(() => {});
    if (m.putThrows) throw new Error("bucket exploded");
    if (m.putRefuses || [...m.putRefusesFor].some((c) => o.path.includes(`/${c}/`))) {
      return { ok: false, reason: "bucket_unconfigured" };
    }
    m.puts.push(o);
    return { ok: true };
  },
}));

function docRef(path: string) {
  return {
    id: path.split("/").pop(),
    path,
    get: async () => {
      const d = m.docs.get(path);
      return { exists: d !== undefined, data: () => d };
    },
    // Synchronous body: the store is updated at call time, as a committed
    // Firestore write would be visible to the next read.
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const contactId = path.split("/")[1] ?? "";
      if ("direction" in data && m.rowWriteFailsFor.has(contactId)) {
        throw new Error("row write refused");
      }
      m.sets.push({ path, data });
      const next: Record<string, unknown> = opts?.merge
        ? { ...(m.docs.get(path) ?? {}) }
        : {};
      for (const [k, v] of Object.entries(data)) {
        if (v === m.DELETE) delete next[k];
        else next[k] = v;
      }
      m.docs.set(path, next);
    },
  };
}

function contactRef(id: string) {
  return {
    id,
    collection: (name: string) => ({
      doc: (docId: string) => docRef(`contacts/${id}/${name}/${docId}`),
    }),
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === "subAccounts") {
        return {
          where: () => ({
            limit: () => ({
              get: async () => ({
                empty: false,
                docs: [
                  {
                    id: "sa_1",
                    data: () => ({
                      agencyId: "ag_1",
                      whatsappEnabledByAgency: true,
                      whatsappProvider: "cloud",
                    }),
                  },
                ],
              }),
            }),
          }),
        };
      }
      const q = {
        where: () => q,
        limit: () => q,
        get: async () => ({
          empty: false,
          docs: m.contactIds.map((id) => ({
            id,
            ref: contactRef(id),
            data: () => ({ name: "Thandi", phone: "+27821234567" }),
          })),
        }),
        doc: (id: string) => contactRef(id),
      };
      return q;
    },
    runTransaction: async (
      fn: (tx: {
        get: (r: ReturnType<typeof docRef>) => ReturnType<ReturnType<typeof docRef>["get"]>;
        set: (r: ReturnType<typeof docRef>, d: Record<string, unknown>, o?: { merge?: boolean }) => void;
      }) => Promise<unknown>,
    ) =>
      fn({
        get: (r) => r.get(),
        set: (r, d, o) => {
          void r.set(d, o);
        },
      }),
    // Atomic: nothing buffered is visible until commit succeeds.
    batch: () => {
      const pending: Array<Record<string, unknown>> = [];
      return {
        update: (_ref: unknown, data: Record<string, unknown>) => {
          pending.push(data);
        },
        set: () => {},
        commit: async () => {
          if (m.commitThrows) throw new Error("contention");
          m.contactUpdates.push(...pending);
        },
      };
    },
  }),
}));

import { POST } from "./route";
import { whatsappMediaPath } from "@/lib/comms/whatsapp/media-storage";
import { parseWhatsappMedia } from "@/types/whatsapp-media";

const BYTES = Buffer.from("\xff\xd8\xff\xe0 pretend this is a jpeg", "latin1");
const hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ROW = "contacts/c_1/whatsappMessages/wamid.M1";

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let onMeta: Handler;
let onBytes: Handler;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;

function metaJson(over: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      messaging_product: "whatsapp",
      url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
      mime_type: "image/jpeg",
      sha256: hex(BYTES),
      file_size: BYTES.length,
      id: "media_1",
      ...over,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function mediaPayload(
  type: string,
  block: Record<string, unknown>,
  id = "wamid.M1",
) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "pn_1" },
              contacts: [{ profile: { name: "Thandi" } }],
              messages: [{ from: "27821234567", id, type, [type]: block }],
            },
          },
        ],
      },
    ],
  };
}

const image = (caption?: string) =>
  mediaPayload("image", {
    id: "media_1",
    mime_type: "image/jpeg",
    sha256: "webhook-side-hash",
    ...(caption ? { caption } : {}),
  });

function post(body: unknown) {
  return POST(
    new Request("http://app.local/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=x" },
      body: JSON.stringify(body),
    }),
  );
}

const row = () => m.docs.get(ROW) ?? {};

beforeEach(() => {
  m.docs.clear();
  m.sets.length = 0;
  m.contactIds = ["c_1"];
  m.conversationUpserts.length = 0;
  m.aiCalls.length = 0;
  m.puts.length = 0;
  m.putThrows = false;
  m.putRefuses = false;
  m.putRefusesFor.clear();
  m.putHangs = false;
  m.putCalls = 0;
  m.rowWriteFailsFor.clear();
  m.commitThrows = false;
  m.contactUpdates.length = 0;
  fetchCalls = [];
  onMeta = async () => metaJson();
  onBytes = async () => new Response(BYTES);
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    return url.startsWith("https://graph.facebook.com/")
      ? onMeta(url, init)
      : onBytes(url, init);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cloud inbound media — the plan's five", () => {
  it("stores a captioned photo and attaches it to the row", async () => {
    expect((await post(image("Look at the pole outside"))).status).toBe(200);

    const storagePath = whatsappMediaPath({
      agencyId: "ag_1",
      subAccountId: "sa_1",
      contactId: "c_1",
      messageDocId: "wamid.M1",
    });
    expect(row()).toMatchObject({
      body: "Look at the pole outside",
      media: {
        kind: "image",
        mimeType: "image/jpeg",
        filename: "photo.jpg",
        sizeBytes: BYTES.length,
        storagePath,
      },
    });
    expect(row()).not.toHaveProperty("mediaDropped");
    expect(m.puts).toHaveLength(1);
    expect(m.puts[0]!.path).toBe(storagePath);
    expect(m.puts[0]!.bytes.equals(BYTES)).toBe(true);
    expect(m.conversationUpserts[0]!.body).toBe("Look at the pole outside");
  });

  it("previews a caption-less voice note by kind", async () => {
    const res = await post(
      mediaPayload("audio", {
        id: "media_1",
        mime_type: "audio/ogg; codecs=opus",
        voice: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({
      body: "",
      media: { kind: "audio", filename: "voice-note.ogg" },
    });
    expect(m.conversationUpserts).toHaveLength(1);
    expect(m.conversationUpserts[0]!.body).toBe("🎤 Voice note");
  });

  it("keeps the message and records fetch_failed when Graph refuses", async () => {
    onMeta = async () => new Response('{"error":{"code":190}}', { status: 401 });

    const res = await post(image("still here"));

    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ body: "still here", mediaDropped: "fetch_failed" });
    expect(row()).not.toHaveProperty("media");
    expect(m.puts).toHaveLength(0);
  });

  it("refuses an oversized file from its declared size, before downloading it", async () => {
    onMeta = async () => metaJson({ file_size: 20 * 1024 * 1024 });

    await post(image());

    expect(row().mediaDropped).toBe("too_large");
    expect(fetchCalls).toHaveLength(1);
    expect(m.puts).toHaveLength(0);
  });

  it("writes a text message exactly as before: one write, the same keys, no fetch", async () => {
    await post({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "pn_1" },
                messages: [
                  { from: "27821234567", id: "wamid.M1", type: "text", text: { body: "hi" } },
                ],
              },
            },
          ],
        },
      ],
    });

    const rowWrites = m.sets.filter((s) => s.path === ROW);
    expect(rowWrites).toHaveLength(1);
    expect(Object.keys(rowWrites[0]!.data).sort()).toEqual(
      [
        "agencyId",
        "subAccountId",
        "contactId",
        "direction",
        "status",
        "body",
        "from",
        "to",
        "provider",
        "providerMessageId",
        "twilioMessageSid",
        "sentByUid",
        "error",
        "readAt",
        "createdAt",
      ].sort(),
    );
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("cloud inbound media — ordering against the redelivery guard", () => {
  it("a Meta retry during a slow download still gets exactly one AI reply", async () => {
    // Only the FIRST metadata call blocks. If the retry blocked too, a broken
    // ordering would deadlock instead of failing, and prove nothing.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    onMeta = async () => {
      if (calls++ === 0) await gate;
      return metaJson();
    };

    const first = post(image("is this the right pole?"));
    await vi.waitFor(() => expect(fetchCalls.length).toBe(1));
    expect((await post(image("is this the right pole?"))).status).toBe(200);
    release();
    expect((await first).status).toBe(200);

    expect(m.aiCalls).toHaveLength(1);
    expect(m.conversationUpserts).toHaveLength(1);
    expect(parseWhatsappMedia(row().media)).not.toBeNull();
  });

  it("turns a throwing store into fetch_failed and still acks with the row intact", async () => {
    m.putThrows = true;

    const res = await post(image("the text survives"));

    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ body: "the text survives", mediaDropped: "fetch_failed" });
    expect(row()).not.toHaveProperty("media");
    expect(m.aiCalls).toHaveLength(1);
  });
});

describe("cloud inbound media — a row never references an object that is not there", () => {
  it("records fetch_failed, not media, when the store refuses without throwing", async () => {
    m.putRefuses = true;

    await post(image());

    expect(row().mediaDropped).toBe("fetch_failed");
    expect(row()).not.toHaveProperty("media");
  });
});

describe("cloud inbound media — never downgrade a row that holds media", () => {
  it("dropped then landed: the retry attaches media and clears mediaDropped", async () => {
    onMeta = async () => new Response("{}", { status: 500 });
    await post(image());
    expect(row().mediaDropped).toBe("fetch_failed");

    onMeta = async () => metaJson();
    await post(image());

    expect(parseWhatsappMedia(row().media)).not.toBeNull();
    expect(row()).not.toHaveProperty("mediaDropped");
  });

  it("landed then retried: no re-fetch and no mediaDropped", async () => {
    await post(image());
    const fetchesAfterFirst = fetchCalls.length;
    expect(parseWhatsappMedia(row().media)).not.toBeNull();

    onMeta = async () => new Response("{}", { status: 500 });
    await post(image());

    expect(fetchCalls).toHaveLength(fetchesAfterFirst);
    expect(parseWhatsappMedia(row().media)).not.toBeNull();
    expect(row()).not.toHaveProperty("mediaDropped");
  });

  it("a slow first delivery that FAILS cannot downgrade media a retry landed meanwhile", async () => {
    // The first delivery's snapshot predates the retry's success, so a drop
    // decided from that snapshot alone would overwrite a good row.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    onMeta = async () => {
      if (calls++ === 0) {
        await gate;
        return new Response("{}", { status: 500 });
      }
      return metaJson();
    };

    const first = post(image());
    await vi.waitFor(() => expect(fetchCalls.length).toBe(1));
    await post(image());
    expect(parseWhatsappMedia(row().media)).not.toBeNull();
    release();
    await first;

    expect(parseWhatsappMedia(row().media)).not.toBeNull();
    expect(row()).not.toHaveProperty("mediaDropped");
  });
});

describe("cloud inbound media — trust nothing Meta or the sender declares", () => {
  it("refuses bytes whose sha256 does not match, without storing them", async () => {
    onMeta = async () => metaJson({ sha256: hex(Buffer.from("different bytes")) });

    await post(image());

    expect(row().mediaDropped).toBe("fetch_failed");
    expect(m.puts).toHaveLength(0);
  });

  it("caps the bytes actually read, whatever file_size claimed", async () => {
    onMeta = async () => metaJson({ file_size: 1024 });
    let pulls = 0;
    onBytes = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            if (pulls > 64) controller.close();
            else controller.enqueue(new Uint8Array(1 << 20));
          },
        }),
      );

    await post(image());

    expect(row().mediaDropped).toBe("too_large");
    expect(m.puts).toHaveLength(0);
    // Stopped reading just past 16 MiB rather than buffering all 64.
    expect(pulls).toBeLessThan(24);
  });

  it("budgets the metadata call at 3s and the download at 15s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await post(image());

    expect(timeout.mock.calls).toEqual([[3_000], [15_000]]);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("caps a hostile document filename at 255 UTF-8 bytes on a code point, keeping .pdf", async () => {
    onMeta = async () => metaJson({ mime_type: "application/pdf" });

    await post(
      mediaPayload("document", {
        id: "media_1",
        mime_type: "application/pdf",
        filename: `${"é".repeat(200)}.pdf`,
      }),
    );

    const filename = parseWhatsappMedia(row().media)?.filename ?? "";
    expect(filename).toBe(`${"é".repeat(125)}.pdf`);
    expect(Buffer.byteLength(filename, "utf8")).toBeLessThanOrEqual(255);
  });

  it("drops a disallowed mime as unsupported_type without contacting Graph", async () => {
    await post(
      mediaPayload("document", {
        id: "media_1",
        mime_type: "application/x-msdownload",
        filename: "invoice.exe",
      }),
    );

    expect(row().mediaDropped).toBe("unsupported_type");
    expect(row()).not.toHaveProperty("media");
    expect(fetchCalls).toHaveLength(0);
  });

  it("takes the kind from the message type, so a webp sticker is a sticker", async () => {
    onMeta = async () => metaJson({ mime_type: "image/webp" });

    await post(mediaPayload("sticker", { id: "media_1", mime_type: "image/webp" }));

    expect(parseWhatsappMedia(row().media)?.kind).toBe("sticker");
  });

  it("never writes the access token to a log line, the response, or the row", async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(
        args
          .map((a) =>
            a instanceof Error
              ? `${a.message} ${a.stack ?? ""}`
              : typeof a === "string"
                ? a
                : JSON.stringify(a),
          )
          .join(" "),
      );
    };
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(capture);
    }
    // A transport error that echoes the request's own Authorization header.
    onMeta = async () => {
      throw new TypeError(`fetch failed: Authorization: Bearer ${TOKEN}`);
    };

    const res = await post(image());
    const body = await res.text();

    // Not vacuous: the failure WAS logged, just not with the token in it.
    expect(logged.some((l) => l.includes("[redacted]"))).toBe(true);
    expect(logged.join("\n")).not.toContain(TOKEN);
    expect(body).not.toContain(TOKEN);
    expect(JSON.stringify(row())).not.toContain(TOKEN);
    expect(row().mediaDropped).toBe("fetch_failed");
  });
});

describe("cloud inbound media — nothing that doesn't need the file waits for it", () => {
  it("indexes the conversation and replies BEFORE the download, so a death mid-download strands nothing", async () => {
    // The first delivery's Graph call never settles — a deploy restart or an
    // OOM in that window. Meta then redelivers the same wamid, which is a
    // redelivery and skips the inbox bump and the AI. They must already have
    // happened, or they never will.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    onMeta = async () => {
      if (calls++ === 0) {
        await gate;
        return new Response("{}", { status: 500 });
      }
      return metaJson();
    };

    const first = post(image("is this the right pole?"));
    await vi.waitFor(() => expect(fetchCalls.length).toBe(1));
    await post(image("is this the right pole?"));

    // Asserted WHILE the first delivery is still blocked in Graph.
    expect(m.conversationUpserts).toHaveLength(1);
    expect(m.aiCalls).toHaveLength(1);
    expect(parseWhatsappMedia(row().media)).not.toBeNull();

    release();
    await first;
  });

  it("previews a caption-less photo for every contact even when one contact's store fails", async () => {
    m.contactIds = ["c_1", "c_2"];
    m.putRefusesFor.add("c_2");

    await post(image());

    expect(m.conversationUpserts.map((u) => u.body)).toEqual(["📷 Photo", "📷 Photo"]);
    expect(parseWhatsappMedia(row().media)).not.toBeNull();
    expect(m.docs.get("contacts/c_2/whatsappMessages/wamid.M1")).toMatchObject({
      mediaDropped: "fetch_failed",
    });
  });

  it("bounds a hung Storage save at 20s and records fetch_failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    m.putHangs = true;

    const pending = post(image("caption survives"));
    // Yield on the real event loop until the route is parked inside the save.
    for (let i = 0; i < 200 && m.putCalls === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(m.putCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ body: "caption survives", mediaDropped: "fetch_failed" });
    expect(row()).not.toHaveProperty("media");
  });

  it("never creates a ghost row holding only media when the text row write failed", async () => {
    m.rowWriteFailsFor.add("c_1");

    const res = await post(image());

    expect(res.status).toBe(200);
    expect(m.docs.has(ROW)).toBe(false);
  });
});

describe("cloud inbound media — the bearer token only goes to Meta", () => {
  it("refuses a download URL on a non-Meta host without requesting it", async () => {
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warned.push(a.map(String).join(" "));
    });
    onMeta = async () => metaJson({ url: "https://evil.example.com/x" });

    await post(image());

    expect(fetchCalls.some((c) => c.url.includes("evil.example.com"))).toBe(false);
    expect(row().mediaDropped).toBe("fetch_failed");
    expect(warned.some((w) => w.includes("evil.example.com"))).toBe(true);
    expect(warned.join("\n")).not.toContain(TOKEN);
  });

  it("refuses a look-alike host that merely starts with a Meta domain", async () => {
    onMeta = async () =>
      metaJson({ url: "https://lookaside.fbsbx.com.evil.example/x" });

    await post(image());

    expect(fetchCalls).toHaveLength(1);
    expect(row().mediaDropped).toBe("fetch_failed");
  });

  it("will not follow a redirect with the bearer token attached", async () => {
    await post(image());

    const download = fetchCalls.find((c) => !c.url.startsWith("https://graph.facebook.com/"));
    expect(download?.init?.redirect).toBe("error");
  });
});

describe("cloud inbound media — opt-outs", () => {
  it("honours STOP sent as a photo caption, keeps the photo, and does not reply", async () => {
    const res = await post(image("STOP"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ optedOut: true });
    expect(m.contactUpdates).toEqual([
      expect.objectContaining({ whatsappOptedOut: true }),
    ]);
    expect(parseWhatsappMedia(row().media)).not.toBeNull();
    expect(m.aiCalls).toHaveLength(0);
  });

  it("answers 503 on a failed opt-out commit, and Meta's retry then records both", async () => {
    m.commitThrows = true;
    expect((await post(image("STOP"))).status).toBe(503);
    expect(m.contactUpdates).toHaveLength(0);

    m.commitThrows = false;
    expect((await post(image("STOP"))).status).toBe(200);

    expect(m.contactUpdates).toEqual([
      expect.objectContaining({ whatsappOptedOut: true }),
    ]);
    expect(parseWhatsappMedia(row().media)).not.toBeNull();
    expect(m.aiCalls).toHaveLength(0);
  });
});

describe("cloud inbound — the AI never replies to an empty message", () => {
  const text = (body: string) => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "pn_1" },
              messages: [
                { from: "27821234567", id: "wamid.M1", type: "text", text: { body } },
              ],
            },
          },
        ],
      },
    ],
  });

  it("skips the AI for a caption-less photo but still indexes it and stores the file", async () => {
    await post(image());

    expect(m.aiCalls).toHaveLength(0);
    expect(m.conversationUpserts).toHaveLength(1);
    expect(parseWhatsappMedia(row().media)).not.toBeNull();
  });

  it("skips the AI for a whitespace-only caption", async () => {
    await post(image(" \n\t "));

    expect(m.aiCalls).toHaveLength(0);
    expect(m.conversationUpserts).toHaveLength(1);
  });

  it("replies to a captioned photo with the caption", async () => {
    await post(image("does this look installed?"));

    expect(m.aiCalls).toHaveLength(1);
    expect(m.aiCalls[0]!.incomingMessage).toBe("does this look installed?");
  });

  it("replies to an emoji-only text — an emoji is not empty", async () => {
    await post(text("👍"));

    expect(m.aiCalls).toHaveLength(1);
    expect(m.aiCalls[0]!.incomingMessage).toBe("👍");
  });
});
