import { MessagesSquare } from "lucide-react";

/**
 * Right pane of the Conversations workspace when no thread is open. The list
 * itself lives in the layout; under lg this pane is hidden and the list fills
 * the screen.
 */
export default function ConversationsPage() {
  return (
    <div className="bg-card/50 flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed p-8 text-center">
      <span className="bg-primary/10 mb-3 flex h-12 w-12 items-center justify-center rounded-full">
        <MessagesSquare className="text-primary h-6 w-6" />
      </span>
      <h2 className="text-base font-semibold">Select a conversation</h2>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm">
        Every email, SMS, WhatsApp &amp; web chat thread in one place.
      </p>
    </div>
  );
}
