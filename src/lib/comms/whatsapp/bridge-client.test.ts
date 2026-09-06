import { describe, it, expect, vi } from "vitest";
import {
  bridgeHealth,
  isGroupJid,
  jidToE164,
  sendWhatsappBridge,
  toWhatsappJid,
  redactJid,
} from "./bridge-client";

const creds = {
  baseUrl: "http://bridge.local:33001",
  token: "tok_secret",
  webhookSecret: "whsec",
};

describe("toWhatsappJid", () => {
  it("turns E.164 into a user JID", () => {
    expect(toWhatsappJid("+27821234567")).toBe("27821234567@s.whatsapp.net");
  });

  it("strips operator-typed spacing and punctuation", () => {
    expect(toWhatsappJid("+27 82 123 4567")).toBe("27821234567@s.whatsapp.net");
  });

  it("strips a twilio-style whatsapp: prefix", () => {
    // Numbers reaching this rail may have been stored by the Twilio path.
    // Go's types.ParseJID rejects the prefixed form outright.
    expect(toWhatsappJid("whatsapp:+27821234567")).toBe(
      "27821234567@s.whatsapp.net"
    );
  });

  it("leaves an already-bare number alone", () => {
    expect(toWhatsappJid("27821234567")).toBe("27821234567@s.whatsapp.net");
  });
});

describe("jidToE164", () => {
  it("is the inverse of toWhatsappJid", () => {
    expect(jidToE164("27821234567@s.whatsapp.net")).toBe("+27821234567");
  });

  it("drops the multi-device suffix", () => {
    // An un-stripped ":12" never matches a stored contact, so every inbound
    // from a multi-device account would mint a brand-new contact.
    expect(jidToE164("27821234567:12@s.whatsapp.net")).toBe("+27821234567");
  });

  it("returns empty for a JID with no digits", () => {
    expect(jidToE164("@s.whatsapp.net")).toBe("");
  });
});

describe("isGroupJid", () => {
  it("flags a group", () => {
    expect(isGroupJid("1234-5678@g.us")).toBe(true);
  });
  it("does not flag a 1:1 chat", () => {
    expect(isGroupJid("27821234567@s.whatsapp.net")).toBe(false);
  });
});

function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("sendWhatsappBridge", () => {
  function send(
    fetchImpl: ReturnType<typeof vi.fn>,
    overrides: Record<string, unknown> = {}
  ) {
    return sendWhatsappBridge({
      creds,
      to: "+27821234567",
      message: "hello",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...overrides,
    });
  }

  it("posts a JID, the text and a key to /v1/send with the bearer token", () => {
    const f = vi
      .fn()
      .mockResolvedValue(res(200, { ok: true, messageId: "M1" }));
    return send(f).then(() => {
      expect(f.mock.calls[0][0]).toBe("http://bridge.local:33001/v1/send");
      const init = f.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer tok_secret"
      );
      expect(JSON.parse(init.body as string)).toMatchObject({
        to: "27821234567@s.whatsapp.net",
        text: "hello",
      });
    });
  });

  it("returns the provider message id on success", async () => {
    const f = vi
      .fn()
      .mockResolvedValue(res(200, { ok: true, messageId: "M1" }));
    await expect(send(f)).resolves.toEqual({ ok: true, messageId: "M1" });
  });

  it("treats a duplicate as success carrying the ORIGINAL message id", async () => {
    // A replayed key must converge on the first send, not report a failure the
    // caller would retry into a second message.
    const f = vi
      .fn()
      .mockResolvedValue(
        res(200, { ok: true, messageId: "M1", duplicate: true })
      );
    await expect(send(f)).resolves.toEqual({ ok: true, messageId: "M1" });
  });

  it("generates an idempotency key when the caller supplies none", async () => {
    // The bridge 400s without one, so an absent key would fail every send.
    const f = vi
      .fn()
      .mockResolvedValue(res(200, { ok: true, messageId: "M1" }));
    await send(f);
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("uses a caller-supplied idempotency key verbatim", async () => {
    const f = vi
      .fn()
      .mockResolvedValue(res(200, { ok: true, messageId: "M1" }));
    await send(f, { idempotencyKey: "wf-step-7" });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.idempotencyKey).toBe("wf-step-7");
  });

  it("treats a 200 with no message id as ambiguous rather than success", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { ok: true }));
    const r = await send(f);
    expect(r).toMatchObject({ ok: false, providerOutcome: "AMBIGUOUS" });
  });

  it.each([400, 401, 403])(
    "marks a %s as definitively rejected so nothing retries it",
    async (status) => {
      const f = vi.fn().mockResolvedValue(res(status, { error: "nope" }));
      const r = await send(f);
      expect(r).toMatchObject({
        ok: false,
        providerOutcome: "DEFINITELY_REJECTED",
      });
    }
  );

  it("surfaces a 422 rail refusal's reason AND machine code to the operator", async () => {
    // refusedBy/reason are the whole point of a 422: "quiet hours" is
    // actionable, "WhatsApp bridge 422" is not.
    const f = vi.fn().mockResolvedValue(
      res(422, {
        ok: false,
        refusedBy: "quiet_hours",
        reason: "outside the configured sending window",
      })
    );
    const r = await send(f);
    expect(r.ok).toBe(false);
    expect(r.providerOutcome).toBe("DEFINITELY_REJECTED");
    // The exact string, not a substring: raw JSON also "contains" both words,
    // so a substring assertion passes even when the operator gets a blob.
    expect(r.error).toBe(
      "WhatsApp bridge 422: quiet_hours: outside the configured sending window"
    );
  });

  it("treats a 409 in-flight key as ambiguous, not rejected", async () => {
    // Another request holds the key and is still sending: it may well land.
    const f = vi
      .fn()
      .mockResolvedValue(res(409, { ok: false, refusedBy: "in_flight" }));
    expect((await send(f)).providerOutcome).toBe("AMBIGUOUS");
  });

  it("prefers the body outcome over the status: 502 failed is rejected", async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        res(502, { ok: false, error: "x", outcome: "failed" })
      );
    expect((await send(f)).providerOutcome).toBe("DEFINITELY_REJECTED");
  });

  it("prefers the body outcome over the status: 502 ambiguous stays ambiguous", async () => {
    // The same status as above, the opposite verdict — which is exactly why
    // the status alone cannot decide this.
    const f = vi
      .fn()
      .mockResolvedValue(
        res(502, { ok: false, error: "timeout", outcome: "ambiguous" })
      );
    expect((await send(f)).providerOutcome).toBe("AMBIGUOUS");
  });

  it("marks a 500 not_sent as rejected so no retry races the caller", async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        res(500, {
          ok: false,
          error: "reservation failed",
          outcome: "not_sent",
        })
      );
    expect((await send(f)).providerOutcome).toBe("DEFINITELY_REJECTED");
  });

  it("treats a network throw as ambiguous, not rejected", async () => {
    const f = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const r = await send(f);
    expect(r).toMatchObject({ ok: false, providerOutcome: "AMBIGUOUS" });
  });

  it("never puts the bearer token in the returned error string", async () => {
    // Send results are surfaced to operators and written to logs.
    const f = vi
      .fn()
      .mockResolvedValue(res(401, { error: "bad token tok_secret" }));
    const r = await send(f);
    expect(r.error).not.toContain("tok_secret");
    expect(r.error).toContain("[redacted]");
  });

  it("still reports a status when the body is not JSON", async () => {
    const f = vi.fn().mockResolvedValue(res(502, "<html>bad gateway</html>"));
    const r = await send(f);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("502");
  });
});

describe("bridgeHealth", () => {
  it("reports connected from a 200", async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        res(200, { ok: true, connected: true, killed: false, number: "+2782" })
      );
    await expect(
      bridgeHealth(creds, { fetchImpl: f as unknown as typeof fetch })
    ).resolves.toEqual({
      reachable: true,
      connected: true,
      killed: false,
      number: "+2782",
    });
  });

  it("reads the body of a 503 rather than calling it unreachable", async () => {
    // A degraded bridge answers 503 WITH the body that says why. Treating that
    // as unreachable hides "needs re-pairing" behind a network error.
    const f = vi
      .fn()
      .mockResolvedValue(
        res(503, { ok: false, connected: false, killed: true })
      );
    const h = await bridgeHealth(creds, {
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(h).toEqual({
      reachable: true,
      connected: false,
      killed: true,
      number: null,
    });
  });

  it("reports unreachable, never throws, when the process is down", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      bridgeHealth(creds, { fetchImpl: f as unknown as typeof fetch })
    ).resolves.toMatchObject({ reachable: false, connected: false });
  });

  it("sends the bearer token to /v1/health", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { connected: true }));
    await bridgeHealth(creds, { fetchImpl: f as unknown as typeof fetch });
    expect(f.mock.calls[0][0]).toBe("http://bridge.local:33001/v1/health");
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok_secret"
    );
  });
});

describe("redactJid", () => {
  it("keeps the server and the last four digits, masks the rest", () => {
    expect(redactJid("27821234567@s.whatsapp.net")).toBe(
      "*******4567@s.whatsapp.net"
    );
    expect(redactJid("155228775178345@lid")).toBe("***********8345@lid");
  });

  it("never leaks a short user part either", () => {
    expect(redactJid("123@s.whatsapp.net")).toBe("***@s.whatsapp.net");
    expect(redactJid("@lid")).toBe("@lid");
  });

  it("tolerates an address with no server at all", () => {
    // A malformed `from` must not throw inside a log line on the drop path.
    expect(redactJid("27821234567")).toBe("*******4567");
  });

  it("leaves no run of the original digits beyond the last four", () => {
    // The point is the log line, so assert the property rather than a literal:
    // nothing but the tail may survive.
    const out = redactJid("27821234567@s.whatsapp.net");
    expect(out).not.toContain("2782123");
  });
});
