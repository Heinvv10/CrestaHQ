"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  MessagesSquare,
  Smartphone,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { useConversationTheme } from "@/hooks/use-conversation-theme";
import { cn } from "@/lib/utils";
import { composerChannelOptions } from "@/lib/conversations/channel-availability";
import { subscribeToContact } from "@/lib/firestore/contacts";
import {
  markConversationRead,
  subscribeToConversation,
} from "@/lib/firestore/conversations";
import { Button } from "@/components/ui/button";
import { ConversationThread } from "@/components/conversations/conversation-thread";
import { ConversationComposer } from "@/components/conversations/conversation-composer";
import { WebChatComposer } from "@/components/conversations/web-chat-composer";
import { ConversationAiControls } from "@/components/conversations/conversation-ai-controls";
import { ConversationDraftCard } from "@/components/conversations/conversation-draft-card";
import { ConversationContactPanel } from "@/components/conversations/conversation-contact-panel";
import { ConversationOwner } from "@/components/conversations/conversation-owner";
import {
  DetailsToggle,
  ThreadTriageActions,
} from "@/components/conversations/thread-header-actions";
import type { EmailMessageDoc } from "@/types/email";
import type { Contact } from "@/types/contacts";
import { scheduleTimeZone } from "@/lib/conversations/schedule-time";
import {
  parseWebChatConversationId,
  type ConversationChannel,
  type ConversationDoc,
} from "@/types/conversations";

const PANEL_KEY = "ls.convo.detailsPanel";

export default function ConversationDetailPage() {
  const params = useParams<{ contactId: string }>();
  // The route segment is the conversation DOC id: a contactId for the
  // contact-keyed channels, or a `web_{sessionId}` key for web chat.
  const conversationId = params.contactId;
  const webSessionId = parseWebChatConversationId(conversationId);
  const isWebChat = !!webSessionId;

  const { user, loading: authLoading } = useAuth();
  const { subAccount, subAccountId, saPath, loading: subLoading } = useSubAccount();
  // The list's filter query, carried back so "Back" returns to the same view.
  const listQuery = useSearchParams().toString();
  const { theme, setTheme } = useConversationTheme();
  const [emailReply, setEmailReply] = useState<EmailMessageDoc | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [conversation, setConversation] = useState<ConversationDoc | null>(null);
  const [convReady, setConvReady] = useState(false);
  const [contactLoading, setContactLoading] = useState(!isWebChat);
  // Right-hand contact panel — collapsed by default; remembered across
  // conversations via localStorage. lg+ only: it overlays the thread on lg
  // (the split view's list pane leaves no room) and docks beside it on xl.
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    try {
      setPanelOpen(localStorage.getItem(PANEL_KEY) === "1");
    } catch {
      /* localStorage unavailable — keep default closed */
    }
  }, []);

  function togglePanel() {
    setPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  // Conversation index doc — subscribed for both modes by its doc id.
  useEffect(() => {
    if (authLoading || !user || !conversationId) return;
    // Not ready until THIS id's doc arrives, so a thread switch never opens
    // the composer on the previous thread's channel.
    setConvReady(false);
    const unsubConv = subscribeToConversation(
      conversationId,
      (c) => {
        setConversation(c);
        setConvReady(true);
      },
      // A contact with no conversation doc yet reads as a rules refusal (the
      // read rule needs resource.data). Settle as "no conversation" so the
      // composer, which waits on this, still renders.
      () => {
        setConversation(null);
        setConvReady(true);
      },
    );
    return () => unsubConv();
  }, [conversationId, user, authLoading]);

  // Contact subscription. Contact-keyed channels load by the route id; web
  // chat loads only once (and if) the session has captured a contact.
  const contactIdToLoad = isWebChat
    ? conversation?.contactId ?? null
    : conversationId;
  useEffect(() => {
    if (authLoading || !user) return;
    if (!contactIdToLoad) {
      setContact(null);
      setContactLoading(false);
      return;
    }
    setContactLoading(true);
    const unsubContact = subscribeToContact(
      contactIdToLoad,
      (c) => {
        setContact(c);
        setContactLoading(false);
      },
      // A deleted contact surfaces as a rules refusal, not an empty snapshot
      // (the read rule needs resource.data). Stop loading either way so the
      // pane shows the not-found state instead of spinning forever.
      () => {
        setContact(null);
        setContactLoading(false);
      },
    );
    return () => unsubContact();
  }, [contactIdToLoad, user, authLoading]);

  // Reset the unread counter as soon as the operator opens the thread. Keyed
  // on the id ONLY: "Mark unread" below must survive staying on the thread,
  // so this must not re-run when the doc's unreadCount changes.
  useEffect(() => {
    if (conversationId) void markConversationRead(conversationId);
  }, [conversationId]);

  // SP2 T7 — every composer channel with its availability and, when it
  // cannot be used, why (connection, agency gate, contact identity, opt-out,
  // Meta identity / prior use). One pure function owns the rule.
  const channelOptions = contact
    ? composerChannelOptions({
        subAccount,
        contact,
        channelsSeen: conversation?.channelsSeen,
      })
    : [];
  const availableChannels: ConversationChannel[] = channelOptions
    .filter((o) => o.available)
    .map((o) => o.channel);

  // Title/subtitle differ by mode. Web chat may be anonymous (no contact), so
  // fall back to the denormalized inbox label.
  const title = isWebChat
    ? contact?.name || conversation?.contactName || "Web visitor"
    : contact?.name || contact?.phone || "Conversation";
  const subtitle = isWebChat
    ? contact?.phone || contact?.email || "Live web chat"
    : contact?.email || contact?.phone || "";

  const loading = isWebChat ? !convReady : contactLoading;
  // SP2 T1 — writes the contact; the server mirrors it onto the conversation.
  const ownerPicker = contact ? (
    <ConversationOwner id="thread-owner" contact={contact} />
  ) : null;
  const listHref = `${saPath("/conversations")}${listQuery ? `?${listQuery}` : ""}`;

  return (
    // Sized by the conversations layout's right pane (split view on lg+).
    <div className="relative flex min-w-0 flex-1 gap-4">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card">
        <header
          data-testid="thread-header"
          className="flex items-center justify-between gap-3 border-b px-4 py-3"
        >
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            render={<Link href={listHref} />}
            aria-label="Back to conversations"
            className="lg:hidden"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {isWebChat ? (
              <Globe className="h-4 w-4" />
            ) : (
              <MessagesSquare className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          {conversation && (
            <ThreadTriageActions
              conversationId={conversationId}
              conversation={conversation}
            />
          )}
          <button
            type="button"
            role="switch"
            aria-checked={theme === "native"}
            onClick={() =>
              setTheme(theme === "native" ? "standard" : "native")
            }
            title="Restyle the thread to each channel's native look"
            className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Smartphone className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Native</span>
            <span
              className={cn(
                "relative inline-flex h-4 w-7 items-center rounded-full transition-colors",
                theme === "native" ? "bg-primary" : "bg-muted-foreground/30",
              )}
            >
              <span
                className={cn(
                  "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
                  theme === "native" ? "translate-x-3.5" : "translate-x-0.5",
                )}
              />
            </span>
          </button>
          {contact && <DetailsToggle open={panelOpen} onToggle={togglePanel} />}
          {contact && (
            <Button
              variant="outline"
              size="sm"
              render={<Link href={saPath(`/contacts/${contact.id}`)} />}
            >
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              Contact
            </Button>
          )}
        </div>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading conversation…</p>
        </div>
      ) : !isWebChat && !contact ? (
        <div
          data-testid="thread-not-found"
          className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
        >
          <p className="text-sm font-medium">
            This contact no longer exists or you can&apos;t access it.
          </p>
          <Link href={listHref} className="text-sm text-primary hover:underline">
            Back to conversations
          </Link>
        </div>
      ) : isWebChat ? (
        <>
          {conversation && (
            <ConversationAiControls
              conversation={conversation}
              trailing={ownerPicker}
            />
          )}
          <ConversationThread
            contactId={conversation?.contactId ?? ""}
            sessionId={webSessionId}
            subAccountId={subAccountId}
            theme={theme}
          />
          {conversation?.pendingDraft && (
            <ConversationDraftCard
              conversationId={conversationId}
              contactId={conversation.contactId}
              subAccountId={subAccountId}
              sessionId={webSessionId}
              draft={conversation.pendingDraft}
            />
          )}
          <WebChatComposer
            subAccountId={subAccountId}
            sessionId={webSessionId!}
          />
        </>
      ) : (
        <>
          {conversation && (
            <ConversationAiControls
              conversation={conversation}
              trailing={ownerPicker}
            />
          )}
          {/* Prefixed: the composer below is keyed by the same id, and two
              siblings sharing a key left a stale duplicate thread on screen. */}
          <ConversationThread key={`thread-${conversationId}`} contactId={conversationId} theme={theme}
            subAccountId={subAccountId}
            scheduleTimeZone={scheduleTimeZone(subAccount?.timezone)}
            onEmailReply={
              availableChannels.includes("email")
                ? // A fresh object per click, so clicking Reply on the SAME
                  // email again (e.g. after switching the composer to an
                  // internal note) still reaches the composer's effect.
                  (m) => setEmailReply({ ...m })
                : undefined
            } />
          {conversation?.pendingDraft && contact && (
            <ConversationDraftCard
              conversationId={conversationId}
              contactId={contact.id}
              subAccountId={subAccountId}
              draft={conversation.pendingDraft}
            />
          )}
          {/* Waits for the conversation doc: the opening channel is its
              lastChannel, and a composer mounted before it would start on
              the fallback instead (SP2 T7). Waits for the workspace doc too:
              until it arrives every agency-gated channel reads as off, so the
              thread would open on another channel and keep it. Once the doc
              is in hand it stays mounted, or a later auth pass would drop
              the reply being typed. */}
          {contact && convReady && !(subLoading && !subAccount) && (
            <ConversationComposer
              key={contact.id}
              emailReply={emailReply?.contactId === contact.id ? emailReply : null}
              onClearEmailReply={() => setEmailReply(null)}
              senderName={user?.displayName ?? null}
              contact={contact}
              availableChannels={availableChannels}
              channelOptions={channelOptions}
              defaultChannel={conversation?.lastChannel ?? null}
            />
          )}
        </>
      )}
      </div>

      {panelOpen && contact && (
        <aside className="absolute inset-y-0 right-0 z-20 hidden w-[340px] shrink-0 overflow-hidden rounded-2xl border bg-card shadow-xl lg:block xl:static xl:shadow-none">
          <ConversationContactPanel contact={contact} onClose={togglePanel} />
        </aside>
      )}
    </div>
  );
}
