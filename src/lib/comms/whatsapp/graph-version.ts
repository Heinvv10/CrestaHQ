/** Graph API version for WhatsApp Cloud calls. See docs/environment.md. */
export function graphVersion(): string {
  return process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";
}
