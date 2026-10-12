import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createMemoryFirestore } from "@/test/memory-firestore";
import { stringsSentToClient } from "@/test/sent-to-client";

/**
 * The public form page (/f) through its real server page. The stored
 * accent goes into the page's CSS variables, and the stored form is handed
 * to the client form as a prop; a value that is not a plain hex must reach
 * neither.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/components/forms/public-form", () => ({
  PublicForm: (p: { form: { id: string } }) => `form:${p.form.id}`,
}));

const { default: PublicFormPage } = await import("./page");

const store = (accent: unknown) =>
  mem.seed("forms/f1", {
    name: "Contact", slug: "contact", enabled: true, agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1",
    fields: [{ id: "email", type: "email", label: "Email", required: true }],
    settings: {
      pipelineStageId: null, autoTags: [], thankYouMessage: "Thanks", redirectUrl: "", createDeal: false,
      dealTitleTemplate: "", dealValue: 0, dealCurrency: "USD",
      appearance: { theme: "light", accent, hideChrome: false, hideTitle: false },
    },
  });
const tree = () => PublicFormPage({ params: Promise.resolve({ formId: "f1" }), searchParams: Promise.resolve({}) });

const HOSTILE = [
  ["extra CSS declarations", "red;position:fixed;inset:0;background:url(https://evil.example/x)"],
  ["a hex followed by more CSS", "#0ea5e9;background:url(https://evil.example/x)"],
  ["markup", '"><script src="https://evil.example/x"></script>'],
  ["a non-string", ["#aabbcc"]],
] as const;
const BAD = /evil\.example|#aabbcc/;

beforeEach(() => mem.clear());

describe("a public form's stored accent leaving the server", () => {
  it.each(HOSTILE)("keeps one that is %s out of the markup and out of the props", async (_label, accent) => {
    store(accent);
    const el = (await tree()) as ReactElement;
    expect(renderToStaticMarkup(el)).not.toMatch(BAD);
    expect(stringsSentToClient(el).filter((s) => BAD.test(s))).toEqual([]);
    expect(stringsSentToClient(el)).toContain("#7c3aed");
  });

  it("keeps a real accent", async () => {
    store("#0ea5e9");
    const el = (await tree()) as ReactElement;
    expect(renderToStaticMarkup(el)).toContain("--primary:#0ea5e9");
    expect(stringsSentToClient(el)).toContain("#0ea5e9");
  });
});
