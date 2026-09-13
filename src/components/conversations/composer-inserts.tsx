"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MessageSquareText } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { useSnippets } from "@/hooks/use-snippets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MergeFieldMenu } from "@/components/snippets/merge-field-menu";
import {
  renderMergeTags,
  type MergeTagContext,
} from "@/lib/messaging/merge-tags";
import type { SnippetDto } from "@/types/snippets";

/**
 * Composer "Snippets" and "Merge fields" buttons (SP2 T3/T4). Both render
 * merge tags at INSERT time against the open conversation (ruling 5), so the
 * operator sees exactly what will be sent. A tag with no value is inserted
 * raw; the composer's Send refuses while one remains.
 */
export function ComposerInserts({
  mergeContext,
  emailActive,
  disabled,
  onInsert,
  onSubject,
}: {
  mergeContext: MergeTagContext;
  emailActive: boolean;
  disabled?: boolean;
  onInsert: (text: string) => void;
  onSubject: (subject: string) => void;
}) {
  const { subAccountId, saPath } = useSubAccount();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { snippets, loading, error } = useSnippets(subAccountId, open);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? snippets.filter(
          (s) =>
            s.name.toLowerCase().includes(q) || s.body.toLowerCase().includes(q)
        )
      : snippets;
  }, [snippets, search]);

  function pick(s: SnippetDto) {
    onInsert(renderMergeTags(s.body, mergeContext).text);
    if (emailActive && s.type === "email" && s.subject) {
      onSubject(renderMergeTags(s.subject, mergeContext).text);
    }
    setOpen(false);
    setSearch("");
  }

  function pickField(tag: string) {
    const r = renderMergeTags(tag, mergeContext);
    onInsert(r.unresolved.length ? tag : r.text);
  }

  return (
    <div className="flex items-center gap-1">
      <div ref={boxRef} className="relative">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title="Insert a snippet"
        >
          <MessageSquareText className="mr-1 h-3.5 w-3.5" />
          Snippets
        </Button>
        {open && (
          <div
            role="dialog"
            aria-label="Snippets"
            className="bg-popover absolute bottom-full left-0 z-30 mb-1 w-72 rounded-lg border p-2 shadow-lg"
          >
            <Input
              autoFocus
              aria-label="Search snippets"
              placeholder="Search snippets"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="mb-2 h-8"
            />
            <div className="max-h-60 overflow-y-auto">
              {error ? (
                <p role="alert" className="text-destructive p-2 text-xs">
                  {error}
                </p>
              ) : loading && snippets.length === 0 ? (
                <p className="text-muted-foreground p-2 text-xs">Loading…</p>
              ) : snippets.length === 0 ? (
                <div className="p-2 text-xs">
                  <p className="text-muted-foreground">No snippets available</p>
                  <Link
                    href={saPath("/conversations/snippets")}
                    className="text-primary underline"
                  >
                    Create a snippet
                  </Link>
                </div>
              ) : visible.length === 0 ? (
                <p className="text-muted-foreground p-2 text-xs">
                  No matching snippets
                </p>
              ) : (
                visible.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => pick(s)}
                    className="hover:bg-muted block w-full rounded-md px-2 py-1.5 text-left"
                  >
                    <span className="block truncate text-xs font-medium">
                      {s.name}
                      {s.type === "email" && (
                        <span className="text-muted-foreground font-normal">
                          {" "}
                          · Email
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground block truncate text-[11px]">
                      {s.body}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      <MergeFieldMenu onPick={pickField} disabled={disabled} />
    </div>
  );
}
