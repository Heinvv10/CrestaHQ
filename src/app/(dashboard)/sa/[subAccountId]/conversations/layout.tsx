"use client";

import { Suspense, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { cn } from "@/lib/utils";
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
 */
export default function ConversationsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const params = useParams<{ contactId?: string }>();
  const threadOpen = !!params.contactId;

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[480px] w-full gap-4">
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
        className={cn("min-w-0 flex-1", threadOpen ? "flex" : "hidden lg:flex")}
      >
        {children}
      </section>
    </div>
  );
}
