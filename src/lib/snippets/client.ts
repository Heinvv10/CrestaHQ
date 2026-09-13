import type { SnippetDto, SnippetInput } from "@/types/snippets";

/**
 * Browser-side calls to /api/sub-accounts/[id]/snippets — the only path to
 * the `snippets` collection (it is closed to the client SDK). Every failure
 * throws with the server's message, or the HTTP status when there is none.
 */

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok)
    throw new Error(data.error ?? `Request failed (HTTP ${res.status}).`);
  return data;
}

const base = (subAccountId: string) =>
  `/api/sub-accounts/${subAccountId}/snippets`;

export async function fetchSnippets(
  subAccountId: string
): Promise<SnippetDto[]> {
  return (await call<{ snippets: SnippetDto[] }>(base(subAccountId))).snippets;
}

export async function saveSnippet(
  subAccountId: string,
  input: SnippetInput,
  id?: string
): Promise<void> {
  await call(id ? `${base(subAccountId)}/${id}` : base(subAccountId), {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteSnippet(
  subAccountId: string,
  id: string
): Promise<void> {
  await call(`${base(subAccountId)}/${id}`, { method: "DELETE" });
}
