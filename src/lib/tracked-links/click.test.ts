import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One visit to `/l/{token}`. Everything that matters happens here: the
 * click is logged, the recipient's own destination wins over the link's,
 * and a KNOWN contact — and only a known contact — is enrolled in a
 * workflow that may message them.
 */

interface StoredLink {
  agencyId: string;
  subAccountId: string;
  name: string;
  destinationUrl: string;
  mode?: "live" | "test";
}

let link: StoredLink | null;
let recipient: Record<string, unknown> | null;

const clicksAdded: Record<string, unknown>[] = [];
const linkUpdates: Record<string, unknown>[] = [];
const recipientUpdates: Record<string, unknown>[] = [];
const fireWorkflowTrigger = vi.fn();

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => {
      if (!path.startsWith("trackedLinks/")) throw new Error(`unexpected ${path}`);
      return {
        get: async () => ({ exists: !!link, data: () => link ?? undefined }),
        update: async (patch: Record<string, unknown>) => {
          linkUpdates.push(patch);
        },
        collection: (name: string) => {
          if (name === "clicks") {
            return {
              add: async (data: Record<string, unknown>) => {
                clicksAdded.push(data);
              },
            };
          }
          if (name === "recipients") {
            return {
              doc: () => ({
                get: async () => ({
                  exists: !!recipient,
                  data: () => recipient ?? undefined,
                }),
                update: async (patch: Record<string, unknown>) => {
                  recipientUpdates.push(patch);
                },
              }),
            };
          }
          throw new Error(`unexpected subcollection ${name}`);
        },
      };
    },
  }),
}));
vi.mock("@/lib/workflows/engine", () => ({
  fireWorkflowTrigger: (...a: unknown[]) => fireWorkflowTrigger(...a),
}));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";

const { resolveTrackedLinkClick } = await import("./click");
const { issueTrackedLinkToken } = await import("./token");

const VISIT = { userAgent: "Mozilla/5.0", referer: "https://wa.me/" };

beforeEach(() => {
  link = {
    agencyId: "ag1",
    subAccountId: "sa1",
    name: "Audit — EDC",
    destinationUrl: "https://example.com/link-default",
  };
  recipient = null;
  clicksAdded.length = 0;
  linkUpdates.length = 0;
  recipientUpdates.length = 0;
  fireWorkflowTrigger.mockReset();
});

describe("resolveTrackedLinkClick — signed per-contact token", () => {
  it("records the click against the contact and fires link.clicked", async () => {
    const token = issueTrackedLinkToken("link1", "contactA");

    const destination = await resolveTrackedLinkClick({ token, ...VISIT });

    expect(destination).toBe("https://example.com/link-default");
    expect(clicksAdded).toHaveLength(1);
    expect(clicksAdded[0]).toMatchObject({
      contactId: "contactA",
      userAgent: "Mozilla/5.0",
      referer: "https://wa.me/",
    });
    expect(linkUpdates).toHaveLength(1);
    expect(fireWorkflowTrigger).toHaveBeenCalledTimes(1);
    expect(fireWorkflowTrigger).toHaveBeenCalledWith({
      agencyId: "ag1",
      subAccountId: "sa1",
      type: "link.clicked",
      contactId: "contactA",
      context: { linkId: "link1", linkName: "Audit — EDC" },
    });
  });

  it("prefers the recipient's destination override over the link's", async () => {
    recipient = { destinationUrl: "https://reports.example.com/edc" };
    const token = issueTrackedLinkToken("link1", "contactA");

    const destination = await resolveTrackedLinkClick({ token, ...VISIT });

    expect(destination).toBe("https://reports.example.com/edc");
    expect(recipientUpdates).toHaveLength(1);
    expect(recipientUpdates[0]).toHaveProperty("firstClickedAt");
  });

  it("falls back to the link destination when the override is null", async () => {
    recipient = { destinationUrl: null, firstClickedAt: "already" };
    const token = issueTrackedLinkToken("link1", "contactA");

    expect(await resolveTrackedLinkClick({ token, ...VISIT })).toBe(
      "https://example.com/link-default",
    );
    expect(recipientUpdates[0]).not.toHaveProperty("firstClickedAt");
  });

  it("never enrols anyone from a test-mode link", async () => {
    link!.mode = "test";
    const token = issueTrackedLinkToken("link1", "contactA");

    expect(await resolveTrackedLinkClick({ token, ...VISIT })).toBe(
      "https://example.com/link-default",
    );
    expect(clicksAdded).toHaveLength(1);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
  });
});

describe("resolveTrackedLinkClick — tokenless /l/{linkId}", () => {
  it("records an unattributed click and fires NOTHING", async () => {
    const destination = await resolveTrackedLinkClick({
      token: "link1",
      ...VISIT,
    });

    expect(destination).toBe("https://example.com/link-default");
    expect(clicksAdded).toHaveLength(1);
    expect(clicksAdded[0]!.contactId).toBeNull();
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
  });
});

describe("resolveTrackedLinkClick — refusals", () => {
  it("404s a forged token without recording or firing anything", async () => {
    const token = issueTrackedLinkToken("link1", "contactA");
    const [linkId, contactId] = token.split(".");
    const forged = `${linkId}.${contactId}.${"0".repeat(64)}`;

    expect(await resolveTrackedLinkClick({ token: forged, ...VISIT })).toBeNull();
    expect(clicksAdded).toHaveLength(0);
    expect(linkUpdates).toHaveLength(0);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
  });

  it("404s an unknown link", async () => {
    link = null;
    expect(
      await resolveTrackedLinkClick({ token: "nosuchlink", ...VISIT }),
    ).toBeNull();
    expect(clicksAdded).toHaveLength(0);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
  });

  it("404s rather than 302 when the stored destination isn't http(s)", async () => {
    link!.destinationUrl = "javascript:alert(1)";
    const token = issueTrackedLinkToken("link1", "contactA");

    expect(await resolveTrackedLinkClick({ token, ...VISIT })).toBeNull();
    expect(clicksAdded).toHaveLength(0);
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
  });

  it("404s when a recipient override is not http(s), even if the link's is", async () => {
    recipient = { destinationUrl: "javascript:alert(1)" };
    const token = issueTrackedLinkToken("link1", "contactA");

    expect(await resolveTrackedLinkClick({ token, ...VISIT })).toBeNull();
    expect(fireWorkflowTrigger).not.toHaveBeenCalled();
  });
});
