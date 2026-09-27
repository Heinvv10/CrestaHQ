/**
 * Request-body caps for the API-key routes. The v1 resource routes take one
 * record per request (a contact, a deal, a form submission of text fields),
 * so 256 KB leaves ample margin. The agent tool
 * routes (/api/v1/tools/{name}, /api/mcp) carry tool args, the largest being
 * update_workflow's trigger + steps (up to 50,000 characters each, so up to
 * ~300 KB of UTF-8, more if JSON-escaped) and MCP batches of several calls:
 * they get 1 MiB.
 */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_AGENT_BODY_BYTES = 1024 * 1024;

/**
 * The body as UTF-8 text, or null when it is over `maxBytes`. A
 * Content-Length over the cap is refused before reading; otherwise the bytes
 * are counted as they stream, since the header may be absent (chunked) or
 * smaller than the body, and reading stops at the first chunk past the cap.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
