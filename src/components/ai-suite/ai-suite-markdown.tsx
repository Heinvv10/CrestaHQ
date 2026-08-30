import { Fragment, type ReactNode } from "react";

/**
 * Tiny dependency-free renderer for the light markdown the AI Suite
 * assistant emits — the prompt asks it for short step lists and plain
 * sentences, so this only needs bold, inline code, bullets, numbered lists,
 * and small headings. Everything is built as React elements (no HTML
 * injection), so model output can't smuggle markup in.
 */

function renderInline(text: string): ReactNode[] {
  // Split on **bold** and `code` spans, preserving the delimiters' content.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={i}
          className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

type Block =
  | { type: "p"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "h"; text: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    const last = blocks[blocks.length - 1];

    if (heading) {
      blocks.push({ type: "h", text: heading[1] });
    } else if (bullet) {
      if (last?.type === "ul") last.items.push(bullet[1]);
      else blocks.push({ type: "ul", items: [bullet[1]] });
    } else if (numbered) {
      if (last?.type === "ol") last.items.push(numbered[1]);
      else blocks.push({ type: "ol", items: [numbered[1]] });
    } else if (last?.type === "p") {
      last.lines.push(trimmed);
    } else {
      blocks.push({ type: "p", lines: [trimmed] });
    }
  }
  return blocks;
}

export function AiSuiteMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.type === "h") {
          return (
            <p key={i} className="font-semibold">
              {renderInline(block.text)}
            </p>
          );
        }
        if (block.type === "ul" || block.type === "ol") {
          const List = block.type === "ul" ? "ul" : "ol";
          return (
            <List
              key={i}
              className={
                block.type === "ul"
                  ? "list-disc space-y-1 pl-5"
                  : "list-decimal space-y-1 pl-5"
              }
            >
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={i}>
            {block.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
