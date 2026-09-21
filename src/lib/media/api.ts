/** Browser calls to the Media Library routes. Each throws the API's error. */

async function send(url: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(payload.error ?? "Request failed."));
  return payload;
}

export function mediaApi(subAccountId: string) {
  const base = `/api/sub-accounts/${subAccountId}/media`;
  return {
    rename: (mediaId: string, name: string) => send(`${base}/${mediaId}`, "PATCH", { name }),
    move: (mediaId: string, folderId: string | null) =>
      send(`${base}/${mediaId}`, "PATCH", { folderId }),
    remove: (mediaId: string) => send(`${base}/${mediaId}`, "DELETE"),
    createFolder: (name: string, parentId: string | null) =>
      send(`${base}/folders`, "POST", { name, parentId }),
    renameFolder: (folderId: string, name: string) =>
      send(`${base}/folders/${folderId}`, "PATCH", { name }),
    removeFolder: (folderId: string) => send(`${base}/folders/${folderId}`, "DELETE"),
  };
}
