/**
 * Speech helpers for the Web Voice custom-LLM endpoint. Deliberately a copy
 * of the Vapi route's helpers rather than a shared refactor, so the live
 * phone-voice route stays untouched.
 */

/**
 * Remove anything that would sound wrong read aloud: leftover [[markers]],
 * markdown emphasis/bullets/headings, link syntax and bare URLs. The voice
 * prompt forbids these, but model output drifts and the TTS engine
 * pronounces every symbol.
 */
export function toSpeakable(text: string): string {
  return (
    text
      .replace(/\[\[[^\]]*\]\]/g, "")
      .replace(/\[\[/g, "")
      .replace(/\]\]/g, "")
      // [label](url) → label
      .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\*\*/g, "")
      .replace(/(?<!\w)\*(?!\w)/g, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-•]\s+/gm, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim()
  );
}

/**
 * OpenAI chat-completion SSE, which is what ElevenLabs' custom-LLM mode
 * requires (`text/event-stream`, `data: {...}` chunks, `data: [DONE]`). The
 * reply is complete before we answer, so it goes out as one content chunk.
 */
export function sseReply(text: string, model: string): Response {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** Non-streaming fallback for a caller that sends `stream: false`. */
export function jsonReply(text: string, model: string): Response {
  return Response.json({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
