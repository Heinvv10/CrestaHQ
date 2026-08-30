"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiSuiteMarkdown } from "@/components/ai-suite/ai-suite-markdown";
import { cn } from "@/lib/utils";
import type {
  AiSuiteChatMessage,
  AiSuiteChatResponse,
  AiSuiteLevel,
} from "@/types/ai-suite";

interface AiSuiteChatProps {
  level: AiSuiteLevel;
  /** Required for sub-account level; passed through to the API for auth. */
  subAccountId?: string;
  /** Fires with true once the thread has any messages, false when it's back
   *  to the empty landing state — lets the page hide the scope banner while
   *  chatting and restore it on New chat. */
  onActiveChange?: (active: boolean) => void;
}

type ProposalStatus = "pending" | "confirmed" | "cancelled" | "failed";

type UiMessage =
  | { role: "user"; kind: "text"; content: string }
  | { role: "assistant"; kind: "text"; content: string }
  | {
      role: "assistant";
      kind: "navigate";
      content: string;
      href: string;
      label: string;
    }
  | {
      role: "assistant";
      kind: "proposal";
      id: string;
      capability: string;
      args: Record<string, unknown>;
      summary: string;
      status: ProposalStatus;
      resultText?: string;
    };

const LANDING_COPY: Record<AiSuiteLevel, { heading: string; sub: string }> = {
  agency: {
    heading: "Ask about running your agency — or ask me to do a few things",
    sub: "I explain how the platform works, and I can create sub-accounts or change a client's feature gates (you confirm before anything happens).",
  },
  "sub-account": {
    heading: "Ask how to use this workspace — or ask me to do a few things",
    sub: "I explain features, and I can create contacts, tasks, or workflows in this client (you confirm before anything happens).",
  },
};

const AGENCY_SUGGESTIONS = [
  "Which sub-accounts have API access enabled?",
  "How many contacts does my biggest client have?",
  "Enable broadcasts for one of my sub-accounts",
  "Set up a community for one of my clients",
];

const SUB_ACCOUNT_SUGGESTIONS = [
  "Set up a webhook to my n8n workflow",
  "Do I have a contact named Jane Doe?",
  "Which workspaces can I access?",
  "Add a task to call Jane Doe tomorrow",
];

/** History sent to the model — proposals collapse to a short status line. */
function toApiHistory(messages: UiMessage[]): AiSuiteChatMessage[] {
  return messages.map((m) => {
    if (m.kind === "text") return { role: m.role, content: m.content };
    if (m.kind === "navigate") {
      return {
        role: "assistant" as const,
        content: `${m.content} (showed an "${m.label}" button)`,
      };
    }
    // proposal (always assistant)
    const status =
      m.status === "confirmed"
        ? m.resultText || m.summary
        : m.status === "cancelled"
          ? `${m.summary} (cancelled by the user)`
          : m.status === "failed"
            ? `${m.summary} (this action failed)`
            : `${m.summary} (awaiting the user's confirmation)`;
    return { role: "assistant", content: status };
  });
}

function threadQuery(level: AiSuiteLevel, subAccountId?: string): string {
  const qs = new URLSearchParams({ level });
  if (subAccountId) qs.set("subAccountId", subAccountId);
  return qs.toString();
}

export function AiSuiteChat({
  level,
  subAccountId,
  onActiveChange,
}: AiSuiteChatProps) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Claude-Code-style auto-grow: the textarea starts one row tall and its
  // height tracks the content (wrap or Shift+Enter) up to the CSS max-height,
  // after which it scrolls internally. Runs on every input change — including
  // the post-send clear, which snaps it back to one row.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Return focus to the prompt whenever a turn finishes. The textarea is
  // disabled while a reply is in flight, and a disabled element drops focus —
  // without this the user has to click back into the input to answer the
  // assistant's follow-up question. Also fires when a confirm round-trip
  // resolves (confirmingId → null), so focus leaves the Confirm button.
  useEffect(() => {
    if (!hydrated || loading || confirmingId) return;
    inputRef.current?.focus();
  }, [hydrated, loading, confirmingId]);

  const suggestions =
    level === "agency" ? AGENCY_SUGGESTIONS : SUB_ACCOUNT_SUGGESTIONS;
  const landing = LANDING_COPY[level];

  // Restore the saved thread on mount so a refresh doesn't lose the
  // conversation (or a pending proposal — confirming re-validates
  // everything server-side, so restored proposals stay actionable).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/ai-suite/thread?${threadQuery(level, subAccountId)}`,
        );
        const data = (await res.json().catch(() => null)) as {
          messages?: UiMessage[];
        } | null;
        if (!cancelled && res.ok && Array.isArray(data?.messages)) {
          setMessages(data.messages);
        }
      } catch {
        /* start fresh */
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [level, subAccountId]);

  // Persist the thread (debounced) after every change. Empty threads are
  // never PUT — clearing goes through the explicit DELETE in newChat().
  useEffect(() => {
    if (!hydrated || messages.length === 0) return;
    const t = setTimeout(() => {
      void fetch("/api/ai-suite/thread", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level, subAccountId, messages }),
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [messages, hydrated, level, subAccountId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  // Report empty↔active to the page (which hides the scope banner while
  // chatting). Only after hydration, so a restored thread doesn't flash the
  // banner before its saved messages land.
  useEffect(() => {
    if (hydrated) onActiveChange?.(messages.length > 0);
  }, [hydrated, messages.length, onActiveChange]);

  function newChat() {
    if (loading || confirmingId) return;
    setMessages([]);
    setError(null);
    void fetch(`/api/ai-suite/thread?${threadQuery(level, subAccountId)}`, {
      method: "DELETE",
    }).catch(() => {});
  }

  async function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    setError(null);
    setInput("");

    const next: UiMessage[] = [
      ...messages,
      { role: "user", kind: "text", content: trimmed },
    ];
    setMessages(next);
    setLoading(true);

    try {
      const res = await fetch("/api/ai-suite/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level,
          subAccountId,
          messages: toApiHistory(next),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | (AiSuiteChatResponse & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok || !data) {
        throw new Error(
          (data as { error?: string })?.error || `Request failed (${res.status})`,
        );
      }

      if ("type" in data && data.type === "proposal") {
        const p = data.proposal;
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            kind: "proposal",
            id: p.id,
            capability: p.capability,
            args: p.args,
            summary: p.summary,
            status: "pending",
          },
        ]);
      } else if ("type" in data && data.type === "navigate") {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            kind: "navigate",
            content: data.text,
            href: data.href,
            label: data.label,
          },
        ]);
      } else if ("type" in data && data.type === "message") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", kind: "text", content: data.text },
        ]);
      } else {
        throw new Error("Unexpected response from the assistant.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  async function confirmProposal(id: string) {
    const msg = messages.find(
      (m): m is Extract<UiMessage, { kind: "proposal" }> =>
        m.kind === "proposal" && m.id === id,
    );
    if (!msg || msg.status !== "pending" || confirmingId) return;
    setError(null);
    setConfirmingId(id);
    try {
      const res = await fetch("/api/ai-suite/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level,
          subAccountId,
          capability: msg.capability,
          args: msg.args,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        resultText?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Action failed (${res.status})`);
      }
      updateProposal(id, { status: "confirmed", resultText: data.resultText });
    } catch (err) {
      const m = err instanceof Error ? err.message : "The action failed.";
      updateProposal(id, { status: "failed", resultText: m });
    } finally {
      setConfirmingId(null);
    }
  }

  function updateProposal(
    id: string,
    patch: { status: ProposalStatus; resultText?: string },
  ) {
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === "proposal" && m.id === id ? { ...m, ...patch } : m,
      ),
    );
  }

  const empty = messages.length === 0;

  // The input is rendered in two places — centered on the empty "landing"
  // state, and docked at the bottom once the thread starts — so it's defined
  // once here and placed by the layout below.
  const inputForm = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send(input);
      }}
      className="flex items-end gap-2"
    >
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send(input);
          }
        }}
        rows={1}
        autoFocus
        placeholder="Ask a question, or ask me to create something…"
        disabled={loading}
        className="max-h-48 flex-1 resize-none overflow-y-auto rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />
      <Button
        type="submit"
        size="icon"
        disabled={loading || !input.trim()}
        aria-label="Send"
      >
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );

  if (!hydrated) {
    return (
      <div className="flex h-full min-h-[24rem] items-center justify-center rounded-xl border bg-card">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[24rem] flex-col rounded-xl border bg-card">
      {empty ? (
        // ── Landing state: greeting + input centered, suggestions beneath ──
        <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/15 via-violet-500/15 to-pink-500/15 text-primary">
              <Sparkles className="h-6 w-6" />
            </span>
            <div>
              <p className="text-base font-medium">{landing.heading}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {landing.sub}
              </p>
            </div>
          </div>

          <div className="w-full max-w-xl">{inputForm}</div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex max-w-xl flex-wrap justify-center gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="rounded-full border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        // ── Thread state: scrolling messages + docked input ──
        <>
          <div className="flex items-center justify-end border-b px-3 py-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={newChat}
              disabled={loading || !!confirmingId}
              className="h-7 gap-1.5 text-xs text-muted-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              New chat
            </Button>
          </div>
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
            {messages.map((m, i) => {
              if (m.kind === "navigate") {
                return (
                  <div key={i} className="flex gap-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed">
                      <p>{m.content}</p>
                      <Link
                        href={m.href}
                        className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                      >
                        {m.label.replace(/\s*→\s*$/, "")}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </div>
                );
              }
              if (m.kind === "proposal") {
                return (
                  <ProposalCard
                    key={m.id}
                    msg={m}
                    busy={confirmingId === m.id}
                    onConfirm={() => confirmProposal(m.id)}
                    onCancel={() => {
                      updateProposal(m.id, { status: "cancelled" });
                      // Cancel doesn't touch loading/confirmingId, so hand
                      // focus back to the prompt directly.
                      inputRef.current?.focus();
                    }}
                  />
                );
              }
              return (
                <div
                  key={i}
                  className={cn(
                    "flex gap-3",
                    m.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  {m.role === "assistant" && (
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Sparkles className="h-4 w-4" />
                    </span>
                  )}
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                      m.role === "user"
                        ? "whitespace-pre-wrap bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {m.role === "assistant" ? (
                      <AiSuiteMarkdown text={m.content} />
                    ) : (
                      m.content
                    )}
                  </div>
                  {m.role === "user" && (
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <User className="h-4 w-4" />
                    </span>
                  )}
                </div>
              );
            })}

            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Thinking…
              </div>
            )}
          </div>

          {error && (
            <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="border-t p-3">{inputForm}</div>
        </>
      )}
    </div>
  );
}

/** Render http(s) URLs in an action result as clickable links. */
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:opacity-80"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

function ProposalCard({
  msg,
  busy,
  onConfirm,
  onCancel,
}: {
  msg: Extract<UiMessage, { kind: "proposal" }>;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="max-w-[80%] flex-1 rounded-2xl border bg-muted/40 px-4 py-3 text-sm">
        <p className="font-medium text-foreground">{msg.summary}</p>

        {msg.status === "pending" && (
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={onConfirm} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              disabled={busy}
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        )}

        {msg.status === "confirmed" && (
          <p className="mt-2 flex items-start gap-1.5 whitespace-pre-wrap text-xs text-emerald-600 dark:text-emerald-400">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              {linkify(msg.resultText || "Done.")}
            </span>
          </p>
        )}
        {msg.status === "cancelled" && (
          <p className="mt-2 text-xs text-muted-foreground">Cancelled.</p>
        )}
        {msg.status === "failed" && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {msg.resultText || "The action failed."}
          </p>
        )}
      </div>
    </div>
  );
}
