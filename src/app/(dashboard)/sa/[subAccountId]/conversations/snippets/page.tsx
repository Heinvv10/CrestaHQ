"use client";

import { useMemo, useState } from "react";
import { ChevronDown, MessageSquareText, Plus, Search } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { useSnippets } from "@/hooks/use-snippets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SELECT_CLASS } from "@/components/assignee-select";
import { SnippetsTable } from "@/components/snippets/snippets-table";
import {
  SnippetEditorDialog,
  type EditorTarget,
} from "@/components/snippets/snippet-editor-dialog";
import { cn } from "@/lib/utils";

const NO_FOLDER = "__none__";

/**
 * Snippets (SP2 T3) — saved replies the composer can insert. Rendered
 * full-width inside the Conversations area (the layout hides the inbox list
 * for this route). A table of snippets is a data surface → max-w-5xl.
 */
export default function SnippetsPage() {
  const { subAccountId } = useSubAccount();
  const { snippets, loading, error, reload } = useSnippets(subAccountId);
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState("");
  const [target, setTarget] = useState<EditorTarget | null>(null);

  const folders = useMemo(
    () =>
      [
        ...new Set(
          snippets.map((s) => s.folder).filter((f): f is string => !!f)
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [snippets]
  );
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return snippets.filter(
      (s) =>
        (!folder || (folder === NO_FOLDER ? !s.folder : s.folder === folder)) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.body.toLowerCase().includes(q))
    );
  }, [snippets, search, folder]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 overflow-y-auto">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Snippets</h1>
          <p className="text-muted-foreground text-sm">
            Saved replies you can drop into any conversation.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm">
                <Plus className="mr-1 h-3.5 w-3.5" />
                New Snippet
                <ChevronDown className="ml-0.5 h-3 w-3 opacity-70" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={() => setTarget({ mode: "create", type: "text" })}
            >
              Add Text Snippet
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setTarget({ mode: "create", type: "email" })}
            >
              Add Email Snippet
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative max-w-sm flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            aria-label="Search snippets"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or body"
            className="pl-8"
          />
        </div>
        <select
          aria-label="Folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          className={cn(SELECT_CLASS, "h-9 sm:w-48")}
        >
          <option value="">All folders</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          <option value={NO_FOLDER}>No folder</option>
        </select>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : loading && snippets.length === 0 ? (
        <div className="bg-muted h-40 w-full animate-pulse rounded-xl" />
      ) : snippets.length === 0 ? (
        <div className="bg-card/50 rounded-xl border border-dashed p-12 text-center">
          <div className="bg-primary/10 mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full">
            <MessageSquareText className="text-primary h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold">No snippets yet</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Create a text or email snippet with New Snippet.
          </p>
        </div>
      ) : (
        <SnippetsTable
          subAccountId={subAccountId}
          snippets={visible}
          onEdit={(snippet) => setTarget({ mode: "edit", snippet })}
          onDeleted={() => void reload()}
        />
      )}

      <SnippetEditorDialog
        subAccountId={subAccountId}
        target={target}
        folders={folders}
        onClose={() => setTarget(null)}
        onSaved={() => void reload()}
      />
    </div>
  );
}
