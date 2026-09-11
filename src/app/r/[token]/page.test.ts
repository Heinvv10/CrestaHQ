import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public review + feedback page (/r/[token]). Characterization of a
 * pre-existing bug: the page read `sub.googleReview`, but the config lives at
 * `googleReviewConfig`, so the Google review link — the page's primary call
 * to action — was never shown. It now reads the configured URL through the
 * canonical-url seam, like the senders do.
 */

const docs = new Map<string, Record<string, unknown>>();
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/reviews/feedback-token", () => ({
  verifyReviewToken: (t: string) => (t === "good-token" ? { contactId: "c1", hash: "h1" } : null),
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (p: string) => ({ get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }) }),
  }),
}));
vi.mock("@/components/reviews/public-review-view", () => ({ PublicReviewView: () => null }));
vi.mock("@/components/brand/logo-mark", () => ({ LogoMark: () => null }));

import { PublicReviewView } from "@/components/reviews/public-review-view";
import PublicReviewPage from "./page";

const CONFIGURED = "https://g.page/r/acme/review";

/** The props the page hands the view. */
async function viewProps(): Promise<Record<string, unknown>> {
  const tree = await PublicReviewPage({ params: Promise.resolve({ token: "good-token" }) });
  const find = (node: ReactNode): ReactElement | null => {
    if (!isValidElement(node)) return null;
    if (node.type === PublicReviewView) return node;
    const kids = (node.props as { children?: ReactNode }).children;
    for (const k of Array.isArray(kids) ? kids : [kids]) {
      const hit = find(k);
      if (hit) return hit;
    }
    return null;
  };
  const view = find(tree);
  expect(view).not.toBeNull();
  return view!.props as Record<string, unknown>;
}

beforeEach(() => {
  docs.clear();
  docs.set("contacts/c1", { reviewTokenHash: "h1", subAccountId: "sa1", name: "Jane Doe" });
});

describe("the Google review link on /r/[token]", () => {
  it("shows the configured googleReviewConfig.reviewUrl", async () => {
    docs.set("subAccounts/sa1", { name: "Acme", googleReviewConfig: { reviewUrl: CONFIGURED } });
    expect(await viewProps()).toMatchObject({ reviewUrl: CONFIGURED, businessName: "Acme", firstName: "Jane" });
  });

  it("never shows the listing's proposed link on its own — only a configured one", async () => {
    docs.set("subAccounts/sa1", {
      name: "Acme",
      googleListing: { newReviewUri: "https://review.fixture.example/fake" },
    });
    expect((await viewProps()).reviewUrl).toBe("");
  });

  it("no config → no link (the view then offers the feedback form only)", async () => {
    docs.set("subAccounts/sa1", { name: "Acme" });
    expect((await viewProps()).reviewUrl).toBe("");
  });
});
