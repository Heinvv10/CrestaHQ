"use client";

import { Suspense, type ReactNode } from "react";
import { useParams, useSelectedLayoutSegment } from "next/navigation";
import { cn } from "@/lib/utils";
import { ConversationsTabs } from "@/components/conversations/conversations-tabs";
import {
  InboxListPane,
  ListSkeleton,
} from "@/components/conversations/inbox-list-pane";

/**
 * Conversations workspace (SP2 I1). Full-bleed split pane: on lg+ the list
 * stays on the left while the open thread (`[contactId]` — a contactId or a
 * `web_{sessionId}` key) renders on the right. Under lg it is list → thread
 * navigation: the list shows on the index route, the thread on its own.
 *
 * The pane widths are fixed here, so the thread's loading / not-found states
 * cannot change the page width.
 *
 * `snippets` (SP2 T3) shares the area and its tab strip but not the list: it
 * renders full-width in place of the split pane.
 */
export default function ConversationsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const params = useParams<{ contactId?: string }>();
  const threadOpen = !!params.contactId;
  const snippets = useSelectedLayoutSegment() === "snippets";

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[480px] w-full flex-col gap-3">
      <ConversationsTabs active={snippets ? "snippets" : "inbox"} />
      {snippets ? (
        <div className="flex min-h-0 flex-1">{children}</div>
      ) : (
        <div className="flex min-h-0 w-full flex-1 gap-4">
          <aside
            data-testid="inbox-list"
            className={cn(
              "min-w-0 flex-col lg:flex lg:w-[380px] lg:shrink-0",
              threadOpen ? "hidden" : "flex w-full"
            )}
          >
            <Suspense fallback={<ListSkeleton />}>
              <InboxListPane />
            </Suspense>
          </aside>
          <section
            className={cn(
              "min-w-0 flex-1",
              threadOpen ? "flex" : "hidden lg:flex"
            )}
          >
            {children}
          </section>
        </div>
      )}
    </div>
  );
}
